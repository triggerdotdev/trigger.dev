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
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createDeploymentChecksWorker,
  deploymentCheckJob,
  deploymentCheckTelemetry,
  enqueueDeploymentCheck,
  getDeploymentChecksController,
  loadDeploymentChecksController,
  runDeploymentCheck,
} from "~/v3/deploymentChecks.server";
import { latestMetrics, metricSum } from "./otlpMetrics.helpers";
import { createInMemoryMetrics } from "./utils/tracing";

vi.setConfig({ testTimeout: 60_000 });

const DIGEST = `sha256:${"c".repeat(64)}`;
const IMAGE = "registry.example.com/deployments/proj_test:20260101.1.prod";
const SHADOW: DeploymentCheckDecision = { plan: "shadow", selectedBy: "sampled" };
const LAST_ATTEMPT = deploymentCheckJob.retry.maxAttempts - 1;
/** An image as the registry read gives it; the job only checks with one. */
const SUPPLIED_IMAGE = {
  manifest: '{"schemaVersion":2}',
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  blobUrls: { [DIGEST]: "https://layers.s3.us-east-1.amazonaws.com/x" },
};

const READ = { kind: "read", image: SUPPLIED_IMAGE } as const;
const READ_RETRY = { kind: "retry", reason: "timed out after 20000 ms" } as const;
/** The tag points to the image the deployments here store. */
const TAG = { kind: "found", digest: DIGEST } as const;

/** The job with a tag lookup and an image read that work, unless a test says otherwise. */
function runCheck(
  job: Parameters<typeof runDeploymentCheck>[0],
  dependencies: NonNullable<Parameters<typeof runDeploymentCheck>[1]>
) {
  return runDeploymentCheck(job, {
    readImage: async () => READ,
    lookupTag: async () => TAG,
    ...dependencies,
  });
}

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
  options: { imageReference?: string | null; type?: "MANAGED" | "UNMANAGED" | "V1" } = {}
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
      type: options.type,
      imageReference:
        options.imageReference === undefined ? `${IMAGE}@${DIGEST}` : options.imageReference,
    },
  });
  return { organization, project, deployment };
}

describe("deployment checks", () => {
  postgresTest(
    "hands the plugin the image the registry gave, read per attempt",
    async ({ prisma }) => {
      // Catches: the supplied image dropped on the way to the plugin, the image not read again on
      // each attempt, or a check run without the image when the read failed.
      const image = SUPPLIED_IMAGE;
      const reads: Array<{
        imageReference: string;
        imageDigest: string;
        projectRef: string;
        isV4Deployment: boolean;
      }> = [];
      const { deployment, project } = await createDeployment(prisma);

      const lookups: Array<{
        imageReference: string;
        projectRef: string;
        isV4Deployment: boolean;
      }> = [];
      const supplied = testPlugin();
      await runCheck(
        { deploymentId: deployment.id, attempt: 0 },
        {
          prisma,
          controller: supplied.controller,
          lookupTag: async (input) => {
            lookups.push(input);
            return TAG;
          },
          readImage: async (input) => {
            reads.push(input);
            return READ;
          },
        }
      );
      expect(lookups).toEqual([
        {
          imageReference: `${IMAGE}@${DIGEST}`,
          projectRef: project.externalRef,
          isV4Deployment: false,
        },
      ]);
      const unread = testPlugin();
      await expect(
        runCheck(
          { deploymentId: deployment.id, attempt: 1 },
          {
            prisma,
            controller: unread.controller,
            readImage: async (input) => {
              reads.push(input);
              return READ_RETRY;
            },
          }
        )
      ).rejects.toThrow("image not read");

      expect(reads).toEqual([
        {
          imageReference: `${IMAGE}@${DIGEST}`,
          imageDigest: DIGEST,
          projectRef: project.externalRef,
          isV4Deployment: false,
        },
        {
          imageReference: `${IMAGE}@${DIGEST}`,
          imageDigest: DIGEST,
          projectRef: project.externalRef,
          isV4Deployment: false,
        },
      ]);
      expect(supplied.checks).toEqual([expect.objectContaining({ imageDigest: DIGEST, image })]);
      expect(unread.checks).toHaveLength(0);

      // A v4 deployment's lookup and read both go to the v4 registry.
      const { deployment: managed } = await createDeployment(prisma, { type: "MANAGED" });
      const registries: Array<[string, boolean]> = [];
      await runCheck(
        { deploymentId: managed.id, attempt: 0 },
        {
          prisma,
          controller: testPlugin().controller,
          lookupTag: async (input) => {
            registries.push(["lookup", input.isV4Deployment]);
            return TAG;
          },
          readImage: async (input) => {
            registries.push(["read", input.isV4Deployment]);
            return READ;
          },
        }
      );
      expect(registries).toEqual([
        ["lookup", true],
        ["read", true],
      ]);

      // The attempt before the last still asks again; the last records no answer, counted once,
      // still without asking the checker.
      const metrics = createInMemoryMetrics();
      onTestFinished(() => metrics.meterProvider.shutdown());
      const telemetry = deploymentCheckTelemetry(metrics.meter);
      await expect(
        runCheck(
          { deploymentId: deployment.id, attempt: LAST_ATTEMPT - 1 },
          { prisma, controller: unread.controller, telemetry, readImage: async () => READ_RETRY }
        )
      ).rejects.toThrow("image not read");
      expect(
        await runCheck(
          { deploymentId: deployment.id, attempt: LAST_ATTEMPT },
          { prisma, controller: unread.controller, telemetry, readImage: async () => READ_RETRY }
        )
      ).toBe("unavailable");
      expect(unread.checks).toHaveLength(0);
      expect(
        metricSum(await latestMetrics(metrics), "deployment_checks.decisions_total", {
          outcome: "unavailable",
          stage: "job",
        })
      ).toBe(1);
    }
  );

  postgresTest(
    "fails an image no read will ever give at once, and asks again on a host that can't read",
    async ({ prisma }) => {
      // Catches: retries spent on an image over the caps or not the project's own, such an image
      // counted as a pass, or a worker without the read role giving up where another may read it.
      const { deployment } = await createDeployment(prisma);
      const unreadable = testPlugin();
      expect(
        await runCheck(
          { deploymentId: deployment.id, attempt: 0 },
          {
            prisma,
            controller: unreadable.controller,
            readImage: async () => ({ kind: "unreadable", reason: "test" }),
          }
        )
      ).toBe("fail");
      expect(unreadable.checks).toHaveLength(0);

      const hostCant = testPlugin();
      const notConfigured = async () => ({ kind: "not_configured", reason: "test" }) as const;
      await expect(
        runCheck(
          { deploymentId: deployment.id, attempt: 0 },
          { prisma, controller: hostCant.controller, readImage: notConfigured }
        )
      ).rejects.toThrow("image not read");
      expect(
        await runCheck(
          { deploymentId: deployment.id, attempt: LAST_ATTEMPT },
          { prisma, controller: hostCant.controller, readImage: notConfigured }
        )
      ).toBe("unavailable");
      expect(hostCant.checks).toHaveLength(0);
    }
  );

  postgresTest("never writes the deployment, whatever the check answers", async ({ prisma }) => {
    // Catches: a background check changing a live deployment.
    const results: DeploymentCheckResult[] = [
      { outcome: "pass", id: "check_1", retryable: false },
      { outcome: "flagged", id: "check_2", retryable: false },
      { outcome: "fail", id: "check_3", retryable: false },
      { outcome: "unavailable", id: "check_4", retryable: false },
      { outcome: "unavailable", id: "check_5", retryable: true },
    ];
    for (const result of results) {
      const { deployment } = await createDeployment(prisma);
      const before = await prisma.workerDeployment.findFirstOrThrow({
        where: { id: deployment.id },
      });

      const { controller } = testPlugin({ result });
      await runCheck({ deploymentId: deployment.id, attempt: 0 }, { prisma, controller })
        // A retryable answer throws so the worker retries.
        .catch(() => {});

      expect(
        await prisma.workerDeployment.findFirstOrThrow({ where: { id: deployment.id } })
      ).toEqual(before);
    }
  });

  postgresTest(
    "fails a deployment whose stored digest isn't the one its tag points to at once, however its images read",
    async ({ prisma }) => {
      // Catches: a mismatch let through, retried, or hidden behind an image that can't be read (an
      // index or an image over the caps under the tag, a digest that names nothing), the images it
      // can read left unchecked or checked as another deployment's, or a busy scanner delaying it.
      const metrics = createInMemoryMetrics();
      onTestFinished(() => metrics.meterProvider.shutdown());
      const telemetry = deploymentCheckTelemetry(metrics.meter);
      const reported = `sha256:${"0".repeat(64)}`;
      const tagged = `sha256:${"d".repeat(64)}`;
      const reads: Record<string, typeof READ | { kind: "unreadable" | "retry"; reason: string }> =
        {
          [reported]: READ,
          [tagged]: { kind: "unreadable", reason: "not a single-image manifest" },
        };
      const { deployment, organization, project } = await createDeployment(prisma, {
        imageReference: `${IMAGE}@${reported}`,
      });
      const mismatched = (controller: DeploymentChecksController) => ({
        prisma,
        controller,
        telemetry,
        lookupTag: async () => ({ kind: "found", digest: tagged }) as const,
        readImage: async ({ imageDigest }: { imageDigest: string }) => reads[imageDigest],
      });

      // The stored image reads, so it is checked, as this deployment's; the tag's can't be.
      const plugin = testPlugin();
      expect(
        await runCheck({ deploymentId: deployment.id, attempt: 0 }, mismatched(plugin.controller))
      ).toBe("fail");
      expect(plugin.checks).toEqual([
        {
          organizationId: organization.id,
          projectRef: project.externalRef,
          deploymentId: deployment.id,
          imageDigest: reported,
          image: SUPPLIED_IMAGE,
          decision: SHADOW,
        },
      ]);

      // Both images read: both are checked, each with its own image.
      const taggedImage = { ...SUPPLIED_IMAGE, manifest: '{"schemaVersion":2,"tagged":true}' };
      reads[tagged] = { kind: "read", image: taggedImage };
      const both = testPlugin();
      expect(
        await runCheck({ deploymentId: deployment.id, attempt: 0 }, mismatched(both.controller))
      ).toBe("fail");
      expect(
        both.checks
          .map(({ imageDigest, image }) => ({ imageDigest, image }))
          .sort((a, b) => a.imageDigest.localeCompare(b.imageDigest))
      ).toEqual([
        { imageDigest: reported, image: SUPPLIED_IMAGE },
        { imageDigest: tagged, image: taggedImage },
      ]);
      reads[tagged] = { kind: "unreadable", reason: "not a single-image manifest" };

      // Neither image reads (a digest that names nothing, an index under the tag): still a fail on
      // the first attempt, with nothing checked.
      const neither = testPlugin();
      reads[reported] = { kind: "retry", reason: "no manifest (ImageNotFound)" };
      expect(
        await runCheck({ deploymentId: deployment.id, attempt: 0 }, mismatched(neither.controller))
      ).toBe("fail");
      expect(neither.checks).toHaveLength(0);

      // Each image is checked whatever the other's scan said, and an error on one side doesn't
      // stop the fail being recorded.
      reads[reported] = READ;
      reads[tagged] = { kind: "read", image: taggedImage };
      for (const throwOn of [undefined, reported, tagged]) {
        const asked: string[] = [];
        const split: DeploymentChecksController = {
          ...testPlugin().controller,
          async check(input) {
            asked.push(input.imageDigest);
            if (input.imageDigest === throwOn) throw new Error("check broke");
            return input.imageDigest === reported
              ? { outcome: "fail", id: "check_stored", retryable: false }
              : { outcome: "flagged", id: "check_tagged", retryable: false };
          },
        };
        expect(await runCheck({ deploymentId: deployment.id, attempt: 0 }, mismatched(split))).toBe(
          "fail"
        );
        expect(asked.sort()).toEqual([reported, tagged].sort());
      }
      reads[tagged] = { kind: "unreadable", reason: "not a single-image manifest" };

      // A busy scanner on the stored image doesn't hold the fail back either, and isn't asked again.
      reads[reported] = READ;
      const busy = testPlugin({
        result: { outcome: "unavailable", id: "check_busy", retryable: true },
      });
      expect(
        await runCheck({ deploymentId: deployment.id, attempt: 0 }, mismatched(busy.controller))
      ).toBe("fail");
      expect(busy.checks.map((check) => check.imageDigest)).toEqual([reported]);
      expect(
        metricSum(await latestMetrics(metrics), "deployment_checks.decisions_total", {
          outcome: "fail",
          mode: "shadow",
        })
      ).toBe(7);
    }
  );

  postgresTest(
    "checks the stored digest at once when the tag can't be looked up, and looks again only after a pass",
    async ({ prisma }) => {
      // Catches: the stored digest left unchecked, or checked late, when the lookup fails (it was
      // checked at once before the lookup existed), a final answer held back by the lookup and
      // scanned again (counting its findings twice), a pass counted although the tag was never
      // compared (hiding the lookup from the no-answer monitors), a failed lookup treated as final
      // too early, or a matching digest failed.
      const { deployment } = await createDeployment(prisma);
      const lookupRetry = async () =>
        ({ kind: "retry", reason: "timed out after 20000 ms" }) as const;
      const notConfigured = async () =>
        ({ kind: "not_configured", reason: "no read role" }) as const;
      const lookupUnreadable = async () =>
        ({ kind: "unreadable", reason: "repository is not the project's" }) as const;

      // A clean scan waits for the lookup, which is tried again on a later attempt.
      for (const lookupTag of [lookupRetry, notConfigured]) {
        const reads: string[] = [];
        const plugin = testPlugin();
        await expect(
          runCheck(
            { deploymentId: deployment.id, attempt: 0 },
            {
              prisma,
              controller: plugin.controller,
              lookupTag,
              readImage: async ({ imageDigest }) => {
                reads.push(imageDigest);
                return READ;
              },
            }
          )
        ).rejects.toThrow("image tag not read");
        expect(reads).toEqual([DIGEST]);
        expect(plugin.checks).toEqual([
          expect.objectContaining({ imageDigest: DIGEST, image: SUPPLIED_IMAGE }),
        ]);
      }

      // Any final answer but a pass stands at once (a fail, a flag, a scan that timed out), so a
      // scan that already answered is never asked for again; so does a busy scanner's on the last
      // attempt.
      for (const [attempt, result] of [
        [0, { outcome: "fail", id: "check_fail", retryable: false }],
        [0, { outcome: "flagged", id: "check_flagged", retryable: false }],
        [0, { outcome: "unavailable", id: "check_timeout", retryable: false }],
        [LAST_ATTEMPT, { outcome: "unavailable", id: "check_busy", retryable: true }],
      ] as const) {
        const plugin = testPlugin({ result });
        expect(
          await runCheck(
            { deploymentId: deployment.id, attempt },
            { prisma, controller: plugin.controller, lookupTag: lookupRetry }
          )
        ).toBe(result.outcome);
        expect(plugin.checks).toHaveLength(1);
      }

      // The stored image's own read and a busy scanner retry as they would with the lookup.
      await expect(
        runCheck(
          { deploymentId: deployment.id, attempt: 0 },
          {
            prisma,
            controller: testPlugin().controller,
            lookupTag: lookupRetry,
            readImage: async () => READ_RETRY,
          }
        )
      ).rejects.toThrow("Deployment check image not read");
      await expect(
        runCheck(
          { deploymentId: deployment.id, attempt: 0 },
          {
            prisma,
            controller: testPlugin({
              result: { outcome: "unavailable", id: "check_busy", retryable: true },
            }).controller,
            lookupTag: lookupRetry,
          }
        )
      ).rejects.toThrow("Deployment check unavailable");

      // The last attempt, or a lookup that can never work: a clean scan doesn't make it a pass,
      // since the tag was never compared.
      for (const [attempt, lookupTag, outcome] of [
        [LAST_ATTEMPT, lookupRetry, "unavailable"],
        [0, lookupUnreadable, "fail"],
      ] as const) {
        const plugin = testPlugin();
        expect(
          await runCheck(
            { deploymentId: deployment.id, attempt },
            { prisma, controller: plugin.controller, lookupTag }
          )
        ).toBe(outcome);
        expect(plugin.checks).toEqual([
          expect.objectContaining({ imageDigest: DIGEST, image: SUPPLIED_IMAGE }),
        ]);
      }

      // With no stored digest there is nothing to check: the lookup is tried again, then no answer,
      // or a fail when it never can work.
      const { deployment: noDigest } = await createDeployment(prisma, { imageReference: IMAGE });
      const none = testPlugin();
      await expect(
        runCheck(
          { deploymentId: noDigest.id, attempt: 0 },
          { prisma, controller: none.controller, lookupTag: lookupRetry }
        )
      ).rejects.toThrow("image tag not read");
      expect(
        await runCheck(
          { deploymentId: noDigest.id, attempt: LAST_ATTEMPT },
          { prisma, controller: none.controller, lookupTag: lookupRetry }
        )
      ).toBe("unavailable");
      expect(
        await runCheck(
          { deploymentId: noDigest.id, attempt: 0 },
          { prisma, controller: none.controller, lookupTag: lookupUnreadable }
        )
      ).toBe("fail");
      expect(none.checks).toHaveLength(0);

      // A stored digest the tag points to: checked as usual, with that digest.
      const matching = testPlugin();
      expect(
        await runCheck(
          { deploymentId: deployment.id, attempt: 0 },
          { prisma, controller: matching.controller }
        )
      ).toBe("pass");
      expect(matching.checks).toEqual([
        expect.objectContaining({ imageDigest: DIGEST, image: SUPPLIED_IMAGE }),
      ]);
    }
  );

  postgresTest("checks what the plugin chose, labelled with its mode", async ({ prisma }) => {
    // Catches: a gate or shadow deploy not checked, a skipped one checked, an image reference
    // the checker can't use sent, the plugin asked about the wrong org or deployment, an org id
    // in the metric attributes, or a flagged answer missing from the counter the deploy scan
    // alerts read.
    const metrics = createInMemoryMetrics();
    const telemetry = deploymentCheckTelemetry(metrics.meter);
    const run = async (
      decision: DeploymentCheckDecision,
      imageReference?: string | null,
      result?: DeploymentCheckResult
    ) => {
      const plugin = testPlugin({ decision, result });
      const { deployment, organization, project } = await createDeployment(prisma, {
        imageReference,
      });
      const lookups: string[] = [];
      const outcome = await runCheck(
        { deploymentId: deployment.id, attempt: 0 },
        {
          prisma,
          controller: plugin.controller,
          telemetry,
          lookupTag: async (input) => {
            lookups.push(input.imageReference);
            return TAG;
          },
        }
      );
      return {
        outcome,
        lookups,
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
    expect(skipped.lookups).toHaveLength(0);
    expect(skipped.decisions).toEqual([
      { organizationId: skipped.organization.id, deploymentId: skipped.deployment.id },
    ]);

    // A stored reference without a digest is checked by its tag.
    const noDigest = await run(SHADOW, IMAGE);
    expect(noDigest.outcome).toBe("pass");
    expect(noDigest.checks).toEqual([expect.objectContaining({ imageDigest: DIGEST })]);

    const noImage = await run(SHADOW, null);
    expect(noImage.outcome).toBe("skipped");
    expect(noImage.checks).toHaveLength(0);
    expect(noImage.lookups).toHaveLength(0);

    for (const decision of [SHADOW, { plan: "gate", selectedBy: "always" } as const]) {
      const checked = await run(decision);
      expect(checked.outcome).toBe("pass");
      expect(checked.checks).toEqual([
        {
          organizationId: checked.organization.id,
          projectRef: checked.project.externalRef,
          deploymentId: checked.deployment.id,
          imageDigest: DIGEST,
          image: SUPPLIED_IMAGE,
          decision,
        },
      ]);
    }

    const flagged = await run(SHADOW, undefined, {
      outcome: "flagged",
      id: "check_flagged",
      retryable: false,
    });
    expect(flagged.outcome).toBe("flagged");

    // The reader also exports every 100 ms, and an earlier export holds partial totals. With
    // cumulative temporality the latest export holds every point.
    const points = ((await latestMetrics(metrics))?.scopeMetrics ?? [])
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "deployment_checks.decisions_total")?.dataPoints;
    expect(points?.map((point) => point.attributes)).toEqual(
      expect.arrayContaining([
        { mode: "shadow", selected_by: "sampled", outcome: "pass", stage: "job" },
        { mode: "gate", selected_by: "always", outcome: "pass", stage: "job" },
        { mode: "shadow", selected_by: "sampled", outcome: "flagged", stage: "job" },
      ])
    );
    for (const point of points ?? []) {
      expect(Object.keys(point.attributes).sort()).toEqual([
        "mode",
        "outcome",
        "selected_by",
        "stage",
      ]);
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
        runCheck({ deploymentId: deployment.id, attempt: 0 }, { prisma, controller })
      ).rejects.toThrow();
      expect(
        await runCheck(
          { deploymentId: deployment.id, attempt: LAST_ATTEMPT },
          { prisma, controller }
        )
      ).toBe("unavailable");

      const final = testPlugin({
        result: { outcome: "unavailable", id: "check_2", retryable: false },
      });
      expect(
        await runCheck(
          { deploymentId: deployment.id, attempt: 0 },
          { prisma, controller: final.controller }
        )
      ).toBe("unavailable");
    }
  );

  postgresTest(
    "retries a failed decision, and records it on the last attempt",
    async ({ prisma }) => {
      // Catches: a failed decision dropped without a record once its retries run out, or a check
      // run without a decision.
      const metrics = createInMemoryMetrics();
      const telemetry = deploymentCheckTelemetry(metrics.meter);
      const { deployment } = await createDeployment(prisma);
      const plugin = testPlugin();
      const controller: DeploymentChecksController = {
        ...plugin.controller,
        async decide() {
          throw new Error("decide broke");
        },
      };

      await expect(
        runCheck({ deploymentId: deployment.id, attempt: 0 }, { prisma, controller, telemetry })
      ).rejects.toThrow("decide broke");
      expect(
        await runCheck(
          { deploymentId: deployment.id, attempt: LAST_ATTEMPT },
          { prisma, controller, telemetry }
        )
      ).toBe("skipped");
      expect(plugin.checks).toHaveLength(0);
      expect(
        metricSum(await latestMetrics(metrics), "deployment_checks.decisions_total", {
          selected_by: "decision_failed",
          stage: "job",
        })
      ).toBe(1);

      // One before the last still retries, and a decision the host can't act on counts the same.
      await expect(
        runCheck(
          { deploymentId: deployment.id, attempt: LAST_ATTEMPT - 1 },
          { prisma, controller, telemetry }
        )
      ).rejects.toThrow("decide broke");
      const malformed: DeploymentChecksController = {
        ...plugin.controller,
        async decide() {
          return { plan: "unknown" } as never;
        },
      };
      expect(
        await runCheck(
          { deploymentId: deployment.id, attempt: LAST_ATTEMPT },
          { prisma, controller: malformed, telemetry }
        )
      ).toBe("skipped");
      const unlabelled: DeploymentChecksController = {
        ...plugin.controller,
        async decide() {
          return { plan: "shadow" } as never;
        },
      };
      expect(
        await runCheck(
          { deploymentId: deployment.id, attempt: LAST_ATTEMPT },
          { prisma, controller: unlabelled, telemetry }
        )
      ).toBe("skipped");
      expect(plugin.checks).toHaveLength(0);
      expect(
        metricSum(await latestMetrics(metrics), "deployment_checks.decisions_total", {
          selected_by: "decision_failed",
          stage: "job",
        })
      ).toBe(3);
      await metrics.meterProvider.shutdown();
    }
  );

  redisTest(
    "queues one check per deployment, only where checks can run, and never throws",
    async ({ redisOptions }) => {
      // Catches: a repeated finalize queuing a second check, a job queued where checks are
      // disabled, or a queue outage failing a deploy that already finished.
      const worker = createDeploymentChecksWorker({
        redisOptions,
        concurrency: { workers: 1, tasksPerWorker: 1, limit: 1 },
        shutdownTimeoutMs: 1_000,
      });
      const canRun = () => true;
      const cannotRun = () => false;
      try {
        await enqueueDeploymentCheck(worker, "deployment_a", canRun);
        await enqueueDeploymentCheck(worker, "deployment_a", canRun);
        await enqueueDeploymentCheck(worker, "deployment_b", canRun);
        await enqueueDeploymentCheck(worker, "deployment_c", cannotRun);
        expect(await worker.queue.size()).toBe(2);
      } finally {
        await worker.stop();
      }

      await expect(enqueueDeploymentCheck(worker, "deployment_d", canRun)).resolves.toBeUndefined();
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
        dependencies: {
          prisma,
          controller: plugin.controller,
          readImage: async () => READ,
          lookupTag: async () => TAG,
        },
      });
      try {
        const { deployment } = await createDeployment(prisma);
        worker.start();
        await enqueueDeploymentCheck(worker, deployment.id, () => true);

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

  it("counts a queued check the worker cannot run", async () => {
    // Catches: a queued check dropped with no trace.
    const metrics = createInMemoryMetrics();
    const telemetry = deploymentCheckTelemetry(metrics.meter);

    expect(
      await runCheck(
        { deploymentId: "deployment_no_plugin", attempt: 0 },
        { controller: null, telemetry }
      )
    ).toBe("no_plugin");

    const dropped = ((await latestMetrics(metrics))?.scopeMetrics ?? [])
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "deployment_checks.no_plugin_total");
    expect(dropped?.dataPoints.map((point) => point.value)).toEqual([1]);
    await metrics.meterProvider.shutdown();
  });
});
