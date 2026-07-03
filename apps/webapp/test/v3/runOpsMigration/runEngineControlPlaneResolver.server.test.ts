// The webapp adapter presents the cross-DB app ControlPlaneResolver as the run-engine seam.
// Proven over real testcontainers (never mocked): resolveEnv maps onto the MinimalAuthenticatedEnv
// superset; resolveWorkerVersion forwards the env type so the engine dequeue dispatch (DEV
// most-recent / MANAGED promotion) runs; assertEnvExists delegates and rejects on a missing env.
import { heteroPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";
import { ControlPlaneCache } from "~/v3/runOpsMigration/controlPlaneCache.server";
import { ControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { RunEngineControlPlaneResolver } from "~/v3/runOpsMigration/runEngineControlPlaneResolver.server";

vi.setConfig({ testTimeout: 60_000 });

let n = 0;

function buildAppResolver(controlPlane: PrismaClient, opts?: { splitEnabled?: boolean }) {
  return new ControlPlaneResolver({
    controlPlanePrimary: controlPlane,
    controlPlaneReplica: controlPlane,
    cache: new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 }),
    splitEnabled: () => opts?.splitEnabled ?? false,
  });
}

/**
 * Wraps a real testcontainer PrismaClient with a `$extends` query hook counting DB operations.
 * Not a mock — the real query still runs; we only observe the boundary to prove cache hits.
 */
function countQueries(client: PrismaClient): { client: PrismaClient; reads: () => number } {
  let count = 0;
  const extended = client.$extends({
    query: {
      async $allOperations({ args, query }) {
        count++;
        return query(args);
      },
    },
  }) as unknown as PrismaClient;
  return { client: extended, reads: () => count };
}

async function seedEnv(prisma: PrismaClient, type: "PRODUCTION" | "DEVELOPMENT") {
  const suffix = `re-${n++}`;
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type,
      slug: suffix,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_${suffix}`,
      pkApiKey: `pk_${suffix}`,
      shortcode: `short_${suffix}`,
      maximumConcurrencyLimit: 9,
    },
  });
  return { organization, project, environment, suffix };
}

async function seedWorker(
  prisma: PrismaClient,
  ctx: { projectId: string; environmentId: string; suffix: string },
  opts: { promote?: boolean; deploy?: boolean }
) {
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${ctx.suffix}`,
      contentHash: `hash_${ctx.suffix}`,
      projectId: ctx.projectId,
      runtimeEnvironmentId: ctx.environmentId,
      version: `2024.1.${ctx.suffix}`,
      metadata: {},
      engine: "V2",
    },
  });
  const task = await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: `task_${ctx.suffix}`,
      slug: "my-task",
      filePath: "index.ts",
      exportName: "myTask",
      workerId: worker.id,
      runtimeEnvironmentId: ctx.environmentId,
      projectId: ctx.projectId,
    },
  });
  const queue = await prisma.taskQueue.create({
    data: {
      friendlyId: `queue_${ctx.suffix}`,
      name: "task/my-task",
      runtimeEnvironmentId: ctx.environmentId,
      projectId: ctx.projectId,
      type: "VIRTUAL",
      workers: { connect: { id: worker.id } },
      tasks: { connect: { id: task.id } },
    },
  });
  if (opts.deploy) {
    const deployment = await prisma.workerDeployment.create({
      data: {
        friendlyId: `deployment_${ctx.suffix}`,
        contentHash: worker.contentHash,
        version: worker.version,
        shortCode: `short_${ctx.suffix}`,
        imageReference: `image:${ctx.suffix}`,
        status: "DEPLOYED",
        projectId: ctx.projectId,
        environmentId: ctx.environmentId,
        workerId: worker.id,
        type: "MANAGED",
      },
    });
    if (opts.promote) {
      await prisma.workerDeploymentPromotion.create({
        data: {
          label: CURRENT_DEPLOYMENT_LABEL,
          deploymentId: deployment.id,
          environmentId: ctx.environmentId,
        },
      });
    }
    return { worker, task, queue, deployment };
  }
  return { worker, task, queue };
}

describe("RunEngineControlPlaneResolver adapter", () => {
  heteroPostgresTest(
    "resolveEnv maps app ResolvedEnv onto ResolvedEngineEnv",
    async ({ prisma14 }) => {
      const { organization, project, environment } = await seedEnv(prisma14, "PRODUCTION");
      const adapter = new RunEngineControlPlaneResolver(buildAppResolver(prisma14));

      const env = await adapter.resolveEnv(environment.id);
      expect(env).not.toBeNull();
      expect(env!.id).toBe(environment.id);
      expect(env!.type).toBe("PRODUCTION");
      expect(env!.projectId).toBe(project.id);
      expect(env!.organizationId).toBe(organization.id);
      // Nested + concurrency fields the run-engine MinimalAuthenticatedEnvironment requires.
      expect(env!.project.id).toBe(project.id);
      expect(env!.organization.id).toBe(organization.id);
      expect(env!.maximumConcurrencyLimit).toBe(9);
      expect(env!.concurrencyLimitBurstFactor.toNumber()).toBe(2);
      expect(env!.archivedAt).toBeNull();

      expect(await adapter.resolveEnv("env_missing")).toBeNull();
    }
  );

  heteroPostgresTest(
    "resolveWorkerVersion (deployed, no workerId) resolves the promoted MANAGED deployment",
    async ({ prisma14 }) => {
      const { project, environment, suffix } = await seedEnv(prisma14, "PRODUCTION");
      const seeded = await seedWorker(
        prisma14,
        { projectId: project.id, environmentId: environment.id, suffix },
        { deploy: true, promote: true }
      );
      const adapter = new RunEngineControlPlaneResolver(buildAppResolver(prisma14));

      const version = await adapter.resolveWorkerVersion({
        environmentId: environment.id,
        type: "PRODUCTION",
      });
      expect(version).not.toBeNull();
      expect(version!.worker.id).toBe(seeded.worker.id);
      expect(version!.deployment?.id).toBe(
        "deployment" in seeded ? seeded.deployment.id : undefined
      );
      expect(version!.tasks.map((t) => t.slug)).toContain("my-task");
    }
  );

  heteroPostgresTest(
    "resolveWorkerVersion (DEVELOPMENT, no workerId) resolves the most-recent worker (no deployment)",
    async ({ prisma14 }) => {
      const { project, environment, suffix } = await seedEnv(prisma14, "DEVELOPMENT");
      const seeded = await seedWorker(
        prisma14,
        { projectId: project.id, environmentId: environment.id, suffix },
        { deploy: false }
      );
      const adapter = new RunEngineControlPlaneResolver(buildAppResolver(prisma14));

      const version = await adapter.resolveWorkerVersion({
        environmentId: environment.id,
        type: "DEVELOPMENT",
      });
      expect(version).not.toBeNull();
      expect(version!.worker.id).toBe(seeded.worker.id);
      expect(version!.deployment).toBeNull();
    }
  );

  heteroPostgresTest(
    "assertEnvExists (split ON) resolves for a present env, rejects for a missing one",
    async ({ prisma14 }) => {
      const { environment } = await seedEnv(prisma14, "PRODUCTION");
      // split ON: the only mode where assertEnvExists asserts (split OFF is a no-op,
      // covered in controlPlaneResolver.server.test.ts).
      const adapter = new RunEngineControlPlaneResolver(
        buildAppResolver(prisma14, { splitEnabled: true })
      );

      await expect(adapter.assertEnvExists(environment.id)).resolves.toBeUndefined();
      await expect(adapter.assertEnvExists("env_missing")).rejects.toThrow();
    }
  );

  heteroPostgresTest(
    "resolveAuthenticatedEnv delegates to the app resolver, returns `git`, and is cached",
    async ({ prisma14 }) => {
      const { environment } = await seedEnv(prisma14, "PRODUCTION");
      const gitMeta = { commitSha: "deadbeef", branchName: "main" };
      await prisma14.runtimeEnvironment.update({
        where: { id: environment.id },
        data: { git: gitMeta },
      });

      // split ON so the delegated app resolver caches; the counter proves the second call
      // is a cache hit rather than re-querying $replica directly (the pre-fix behavior).
      const { client: counting, reads } = countQueries(prisma14);
      const adapter = new RunEngineControlPlaneResolver(
        buildAppResolver(counting, { splitEnabled: true })
      );

      const first = await adapter.resolveAuthenticatedEnv(environment.id);
      expect(first).not.toBeNull();
      expect(first!.id).toBe(environment.id);
      expect(first!.git).toEqual(gitMeta);
      expect(reads()).toBe(1);

      const second = await adapter.resolveAuthenticatedEnv(environment.id);
      expect(second!.git).toEqual(gitMeta);
      expect(reads()).toBe(1);
    }
  );

  heteroPostgresTest(
    "resolveAuthenticatedEnv returns null for a deleted project",
    async ({ prisma14 }) => {
      const { environment, project } = await seedEnv(prisma14, "PRODUCTION");
      await prisma14.project.update({
        where: { id: project.id },
        data: { deletedAt: new Date() },
      });

      const adapter = new RunEngineControlPlaneResolver(buildAppResolver(prisma14));

      expect(await adapter.resolveAuthenticatedEnv(environment.id)).toBeNull();
    }
  );
});
