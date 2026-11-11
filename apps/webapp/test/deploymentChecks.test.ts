import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { containerTestWithIsolatedRedis, postgresTest, redisTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type {
  DeploymentCheckDecision,
  DeploymentCheckDecisionInput,
  DeploymentCheckInput,
  DeploymentCheckResult,
  DeploymentChecksController,
} from "@trigger.dev/plugins";
import { describe, expect, it, vi } from "vitest";
import {
  createDeploymentChecksWorker,
  deploymentCheckJob,
  deploymentCheckTelemetry,
  enqueueDeploymentCheck,
  getDeploymentChecksController,
  loadDeploymentChecksController,
  runDeploymentCheck,
} from "~/v3/deploymentChecks.server";
import { latestMetrics } from "./otlpMetrics.helpers";
import { createInMemoryMetrics } from "./utils/tracing";

vi.setConfig({ testTimeout: 60_000 });

const DIGEST = `sha256:${"c".repeat(64)}`;
const IMAGE = "registry.example.com/deployments/proj_test:20260101.1.prod";
const SHADOW: DeploymentCheckDecision = { plan: "shadow", selectedBy: "sampled" };
const LAST_ATTEMPT = deploymentCheckJob.retry.maxAttempts - 1;

/**
 * Stands in for the deployment checks plugin, which this repository doesn't ship. It answers with a
 * fixed decision and result and keeps what the host sent, so the tests can check the host's side.
 */
function testPlugin({
  decision = SHADOW,
  result = { outcome: "pass", id: "check_1", retryable: false },
}: {
  decision?: DeploymentCheckDecision;
  result?: DeploymentCheckResult;
} = {}) {
  const decisions: DeploymentCheckDecisionInput[] = [];
  const checks: DeploymentCheckInput[] = [];
  const controller: DeploymentChecksController = {
    async decide(input) {
      decisions.push(input);
      return decision;
    },
    async check(input) {
      checks.push(input);
      return result;
    },
  };
  return { controller, decisions, checks };
}

async function createDeployment(
  prisma: PrismaClient,
  options: { imageReference?: string | null } = {}
) {
  const suffix = randomBytes(8).toString("hex");
  const organization = await prisma.organization.create({
    data: { title: "Org", slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: "Project",
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: suffix,
      projectId: project.id,
      organizationId: organization.id,
    },
  });
  const deployment = await prisma.workerDeployment.create({
    data: {
      friendlyId: `deployment_${suffix}`,
      shortCode: suffix,
      contentHash: suffix,
      version: "20260101.1",
      projectId: project.id,
      environmentId: environment.id,
      status: "DEPLOYED",
      deployedAt: new Date(),
      imageReference:
        options.imageReference === undefined ? `${IMAGE}@${DIGEST}` : options.imageReference,
    },
  });
  return { organization, project, deployment };
}

describe("deployment checks", () => {
  postgresTest("never writes the deployment, whatever the check answers", async ({ prisma }) => {
    // Catches: a background check changing a live deployment.
    const results: DeploymentCheckResult[] = [
      { outcome: "pass", id: "check_1", retryable: false },
      { outcome: "fail", id: "check_2", retryable: false },
      { outcome: "unavailable", id: "check_3", retryable: false },
      { outcome: "unavailable", id: "check_4", retryable: true },
    ];
    for (const result of results) {
      const { deployment } = await createDeployment(prisma);
      const before = await prisma.workerDeployment.findFirstOrThrow({
        where: { id: deployment.id },
      });

      const { controller } = testPlugin({ result });
      await runDeploymentCheck({ deploymentId: deployment.id, attempt: 0 }, { prisma, controller })
        // A retryable answer throws so the worker retries.
        .catch(() => {});

      expect(
        await prisma.workerDeployment.findFirstOrThrow({ where: { id: deployment.id } })
      ).toEqual(before);
    }
  });

  postgresTest("checks what the plugin chose, labelled with its mode", async ({ prisma }) => {
    // Catches: a gate or shadow deploy not checked, a skipped one checked, an image reference
    // the checker can't use sent, the plugin asked about the wrong org or deployment, or an org
    // id in the metric attributes.
    const metrics = createInMemoryMetrics();
    const telemetry = deploymentCheckTelemetry(metrics.meter);
    const run = async (decision: DeploymentCheckDecision, imageReference?: string | null) => {
      const plugin = testPlugin({ decision });
      const { deployment, organization, project } = await createDeployment(prisma, {
        imageReference,
      });
      const outcome = await runDeploymentCheck(
        { deploymentId: deployment.id, attempt: 0 },
        { prisma, controller: plugin.controller, telemetry }
      );
      return {
        outcome,
        decisions: plugin.decisions,
        checks: plugin.checks,
        deployment,
        organization,
        project,
      };
    };

    const skipped = await run({ plan: "skip", selectedBy: "off" });
    expect(skipped.outcome).toBe("skipped");
    expect(skipped.checks).toHaveLength(0);
    expect(skipped.decisions).toEqual([
      { organizationId: skipped.organization.id, deploymentId: skipped.deployment.id },
    ]);

    const noDigest = await run(SHADOW, IMAGE);
    expect(noDigest.outcome).toBe("skipped");
    expect(noDigest.checks).toHaveLength(0);

    for (const decision of [SHADOW, { plan: "gate", selectedBy: "always" } as const]) {
      const checked = await run(decision);
      expect(checked.outcome).toBe("pass");
      expect(checked.checks).toEqual([
        {
          organizationId: checked.organization.id,
          projectRef: checked.project.externalRef,
          deploymentId: checked.deployment.id,
          imageDigest: DIGEST,
          decision,
        },
      ]);
    }

    // The reader also exports every 100 ms, and an earlier export holds partial totals. With
    // cumulative temporality the latest export holds every point.
    const points = ((await latestMetrics(metrics))?.scopeMetrics ?? [])
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "deployment_checks.decisions_total")?.dataPoints;
    expect(points?.map((point) => point.attributes)).toEqual(
      expect.arrayContaining([
        { mode: "shadow", selected_by: "sampled", outcome: "pass" },
        { mode: "gate", selected_by: "always", outcome: "pass" },
      ])
    );
    for (const point of points ?? []) {
      expect(Object.keys(point.attributes).sort()).toEqual(["mode", "outcome", "selected_by"]);
    }
    await metrics.meterProvider.shutdown();
  });

  postgresTest(
    "retries a transient no-answer and settles on the last attempt",
    async ({ prisma }) => {
      // Catches: a checker outage dropped after one try, or retried without end.
      const { deployment } = await createDeployment(prisma);
      const { controller } = testPlugin({
        result: { outcome: "unavailable", id: "check_1", retryable: true },
      });

      await expect(
        runDeploymentCheck({ deploymentId: deployment.id, attempt: 0 }, { prisma, controller })
      ).rejects.toThrow();
      expect(
        await runDeploymentCheck(
          { deploymentId: deployment.id, attempt: LAST_ATTEMPT },
          { prisma, controller }
        )
      ).toBe("unavailable");

      const final = testPlugin({
        result: { outcome: "unavailable", id: "check_2", retryable: false },
      });
      expect(
        await runDeploymentCheck(
          { deploymentId: deployment.id, attempt: 0 },
          { prisma, controller: final.controller }
        )
      ).toBe("unavailable");
    }
  );

  redisTest(
    "queues one check per deployment, only with a plugin, and never throws",
    async ({ redisOptions }) => {
      // Catches: a repeated finalize queuing a second check, a job queued with no plugin to run
      // it, or a queue outage failing a deploy that already finished.
      const worker = createDeploymentChecksWorker({
        redisOptions,
        concurrency: { workers: 1, tasksPerWorker: 1, limit: 1 },
        shutdownTimeoutMs: 1_000,
      });
      const withPlugin = async () => testPlugin().controller;
      const withoutPlugin = async () => null;
      try {
        await enqueueDeploymentCheck(worker, "deployment_a", withPlugin);
        await enqueueDeploymentCheck(worker, "deployment_a", withPlugin);
        await enqueueDeploymentCheck(worker, "deployment_b", withPlugin);
        await enqueueDeploymentCheck(worker, "deployment_c", withoutPlugin);
        expect(await worker.queue.size()).toBe(2);
      } finally {
        await worker.stop();
      }

      await expect(
        enqueueDeploymentCheck(worker, "deployment_d", withPlugin)
      ).resolves.toBeUndefined();
    }
  );

  containerTestWithIsolatedRedis(
    "runs a queued check on the deployment checks worker",
    async ({ prisma, redisOptions }) => {
      // Catches: the job not registered on the worker, so queued checks never run.
      const plugin = testPlugin();
      const worker = createDeploymentChecksWorker({
        redisOptions,
        concurrency: { workers: 1, tasksPerWorker: 1, limit: 1 },
        shutdownTimeoutMs: 1_000,
        pollIntervalMs: 50,
        dependencies: { prisma, controller: plugin.controller },
      });
      try {
        const { deployment } = await createDeployment(prisma);
        worker.start();
        await enqueueDeploymentCheck(worker, deployment.id, async () => plugin.controller);

        const deadline = performance.now() + 10_000;
        while (plugin.checks.length === 0 && performance.now() < deadline) await setTimeout(20);
        expect(
          plugin.checks.map((check) => check.deploymentId),
          "check never ran"
        ).toEqual([deployment.id]);
      } finally {
        await worker.stop();
      }
    }
  );

  it("shares one load between callers", async () => {
    // Catches: concurrent first checks each creating a controller with its own database pools.
    const first = getDeploymentChecksController();
    expect(getDeploymentChecksController()).toBe(first);
    await first;
    expect(getDeploymentChecksController()).toBe(first);
  });

  it("loads nothing off Cloud, and treats a missing plugin as off unless plugins are required", async () => {
    // Catches: REQUIRE_PLUGINS bypassed when the host doesn't look like Cloud, or a missing
    // plugin on Cloud going unnoticed.
    const metrics = createInMemoryMetrics();
    const telemetry = deploymentCheckTelemetry(metrics.meter);
    const moduleName = "@triggerdotdev/plugins/not-installed";

    expect(
      await loadDeploymentChecksController({ requirePlugins: false, cloud: false, moduleName })
    ).toBeNull();
    expect(
      await loadDeploymentChecksController({
        requirePlugins: false,
        cloud: true,
        moduleName,
        telemetry,
      })
    ).toBeNull();
    await expect(
      loadDeploymentChecksController({ requirePlugins: true, cloud: false, moduleName })
    ).rejects.toThrow("REQUIRE_PLUGINS=1");

    const missing = ((await latestMetrics(metrics))?.scopeMetrics ?? [])
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "deployment_checks.plugin_missing_total");
    expect(missing?.dataPoints.map((point) => point.value)).toEqual([1]);
    await metrics.meterProvider.shutdown();
  });
});
