/**
 * TRI-13291: the dequeue worker-version resolve reads the currently-promoted worker fresh on every
 * call. The previous env-keyed TTL cache served the superseded worker for up to the TTL after a
 * deployment promotion / dev re-register (nothing invalidated it); it has been removed, so a
 * promotion or re-register is reflected on the very next resolve. The DB is never mocked: every
 * query runs against the real Postgres container.
 */
import { postgresTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import type { PrismaClient, PrismaReplicaClient } from "@trigger.dev/database";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import { ControlPlaneCache } from "./controlPlaneCache.server";
import { ControlPlaneResolver } from "./controlPlaneResolver.server";

let n = 0;

async function seedEnv(prisma: PrismaClient, type: "PRODUCTION" | "DEVELOPMENT" = "PRODUCTION") {
  const s = n++;
  const organization = await prisma.organization.create({
    data: { title: `Org ${s}`, slug: `org-${s}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `P ${s}`,
      slug: `p-${s}`,
      externalRef: `proj_${s}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type,
      slug: `env-${s}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_${s}`,
      pkApiKey: `pk_${s}`,
      shortcode: `sc_${s}`,
    },
  });
  return { organization, project, environment };
}

async function seedWorkerWithTask(
  prisma: PrismaClient,
  ctx: { projectId: string; runtimeEnvironmentId: string },
  version: string,
  taskSlug: string
) {
  const s = n++;
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${s}`,
      version,
      contentHash: `hash_${s}`,
      projectId: ctx.projectId,
      runtimeEnvironmentId: ctx.runtimeEnvironmentId,
      metadata: {},
    },
  });
  await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: `task_${s}`,
      slug: taskSlug,
      filePath: `src/${taskSlug}.ts`,
      workerId: worker.id,
      projectId: ctx.projectId,
      runtimeEnvironmentId: ctx.runtimeEnvironmentId,
    },
  });
  return worker;
}

async function seedManagedDeployment(
  prisma: PrismaClient,
  ctx: { projectId: string; environmentId: string; workerId: string },
  version: string
) {
  const s = n++;
  return prisma.workerDeployment.create({
    data: {
      friendlyId: `deploy_${s}`,
      shortCode: `dep${s}`,
      contentHash: `dhash_${s}`,
      version,
      type: "MANAGED",
      status: "DEPLOYED",
      projectId: ctx.projectId,
      environmentId: ctx.environmentId,
      workerId: ctx.workerId,
    },
  });
}

async function promote(prisma: PrismaClient, environmentId: string, deploymentId: string) {
  await prisma.workerDeploymentPromotion.upsert({
    where: { environmentId_label: { environmentId, label: CURRENT_DEPLOYMENT_LABEL } },
    create: { deploymentId, environmentId, label: CURRENT_DEPLOYMENT_LABEL },
    update: { deploymentId },
  });
}

function makeResolver(prisma: PrismaClient, freshRead = true) {
  return new ControlPlaneResolver({
    controlPlanePrimary: prisma,
    controlPlaneReplica: prisma as unknown as PrismaReplicaClient,
    cache: new ControlPlaneCache(),
    splitEnabled: () => true,
    workerVersionFreshReadEnabled: () => freshRead,
  });
}

describe("ControlPlaneResolver worker-version dispatch freshness (TRI-13291)", () => {
  postgresTest(
    "deployed :current: resolves the newly-promoted worker on the next call (no stale cache)",
    async ({ prisma }) => {
      const { project, environment } = await seedEnv(prisma);
      const ctx = { projectId: project.id, runtimeEnvironmentId: environment.id };

      const workerV1 = await seedWorkerWithTask(prisma, ctx, "20240101.1", "task-a");
      const workerV2 = await seedWorkerWithTask(prisma, ctx, "20240101.2", "task-a");
      const depV1 = await seedManagedDeployment(
        prisma,
        { projectId: project.id, environmentId: environment.id, workerId: workerV1.id },
        "20240101.1"
      );
      const depV2 = await seedManagedDeployment(
        prisma,
        { projectId: project.id, environmentId: environment.id, workerId: workerV2.id },
        "20240101.2"
      );

      await promote(prisma, environment.id, depV1.id);

      const resolver = makeResolver(prisma);

      const first = await resolver.resolveWorkerVersion({
        environmentId: environment.id,
        type: "PRODUCTION",
        taskIdentifier: "task-a",
      });
      expect(first?.worker.id).toBe(workerV1.id);
      expect(first?.worker.version).toBe("20240101.1");

      await promote(prisma, environment.id, depV2.id);

      const afterPromotion = await resolver.resolveWorkerVersion({
        environmentId: environment.id,
        type: "PRODUCTION",
        taskIdentifier: "task-a",
      });
      expect(afterPromotion?.worker.id).toBe(workerV2.id);
      expect(afterPromotion?.worker.version).toBe("20240101.2");
    },
    30_000
  );

  postgresTest(
    "deployed :current: resolves the rolled-back worker on the next call",
    async ({ prisma }) => {
      const { project, environment } = await seedEnv(prisma);
      const ctx = { projectId: project.id, runtimeEnvironmentId: environment.id };

      const workerV1 = await seedWorkerWithTask(prisma, ctx, "20240101.1", "task-a");
      const workerV2 = await seedWorkerWithTask(prisma, ctx, "20240101.2", "task-a");
      const depV1 = await seedManagedDeployment(
        prisma,
        { projectId: project.id, environmentId: environment.id, workerId: workerV1.id },
        "20240101.1"
      );
      const depV2 = await seedManagedDeployment(
        prisma,
        { projectId: project.id, environmentId: environment.id, workerId: workerV2.id },
        "20240101.2"
      );

      await promote(prisma, environment.id, depV2.id);
      const resolver = makeResolver(prisma);
      const onV2 = await resolver.resolveWorkerVersion({
        environmentId: environment.id,
        type: "PRODUCTION",
        taskIdentifier: "task-a",
      });
      expect(onV2?.worker.id).toBe(workerV2.id);

      await promote(prisma, environment.id, depV1.id);
      const rolledBack = await resolver.resolveWorkerVersion({
        environmentId: environment.id,
        type: "PRODUCTION",
        taskIdentifier: "task-a",
      });
      expect(rolledBack?.worker.id).toBe(workerV1.id);
    },
    30_000
  );

  postgresTest(
    "dev :current: resolves the re-registered worker on the next call",
    async ({ prisma }) => {
      const { project, environment } = await seedEnv(prisma, "DEVELOPMENT");
      const ctx = { projectId: project.id, runtimeEnvironmentId: environment.id };

      const workerV1 = await seedWorkerWithTask(prisma, ctx, "20240101.1", "task-a");

      const resolver = makeResolver(prisma);
      const first = await resolver.resolveWorkerVersion({
        environmentId: environment.id,
        type: "DEVELOPMENT",
        taskIdentifier: "task-a",
      });
      expect(first?.worker.id).toBe(workerV1.id);

      const workerV2 = await seedWorkerWithTask(prisma, ctx, "20240101.2", "task-a");

      const afterReregister = await resolver.resolveWorkerVersion({
        environmentId: environment.id,
        type: "DEVELOPMENT",
        taskIdentifier: "task-a",
      });
      expect(afterReregister?.worker.id).toBe(workerV2.id);
    },
    30_000
  );

  postgresTest(
    "resolves only the matched task and queue (per-slug/per-queue dispatch)",
    async ({ prisma }) => {
      const { project, environment } = await seedEnv(prisma);
      const ctx = { projectId: project.id, runtimeEnvironmentId: environment.id };

      const worker = await seedWorkerWithTask(prisma, ctx, "20240101.1", "task-a");
      await prisma.backgroundWorkerTask.create({
        data: {
          friendlyId: `task_extra_${n++}`,
          slug: "task-b",
          filePath: "src/task-b.ts",
          workerId: worker.id,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
        },
      });
      const qA = await prisma.taskQueue.create({
        data: {
          friendlyId: `q_${n++}`,
          name: "queue-a",
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
          workers: { connect: { id: worker.id } },
        },
      });
      await prisma.taskQueue.create({
        data: {
          friendlyId: `q_${n++}`,
          name: "queue-b",
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
          workers: { connect: { id: worker.id } },
        },
      });
      const dep = await seedManagedDeployment(
        prisma,
        { projectId: project.id, environmentId: environment.id, workerId: worker.id },
        "20240101.1"
      );
      await promote(prisma, environment.id, dep.id);

      const resolved = await makeResolver(prisma).resolveWorkerVersion({
        environmentId: environment.id,
        type: "PRODUCTION",
        taskIdentifier: "task-a",
        queue: { name: "queue-a" },
      });

      expect(resolved?.tasks.map((t) => t.slug)).toEqual(["task-a"]);
      expect(resolved?.queues.map((q) => q.id)).toEqual([qA.id]);
    },
    30_000
  );

  postgresTest(
    "kill-switch off falls back to the legacy env-keyed cache (serves the pre-promotion worker)",
    async ({ prisma }) => {
      const { project, environment } = await seedEnv(prisma);
      const ctx = { projectId: project.id, runtimeEnvironmentId: environment.id };

      const workerV1 = await seedWorkerWithTask(prisma, ctx, "20240101.1", "task-a");
      const workerV2 = await seedWorkerWithTask(prisma, ctx, "20240101.2", "task-a");
      const depV1 = await seedManagedDeployment(
        prisma,
        { projectId: project.id, environmentId: environment.id, workerId: workerV1.id },
        "20240101.1"
      );
      const depV2 = await seedManagedDeployment(
        prisma,
        { projectId: project.id, environmentId: environment.id, workerId: workerV2.id },
        "20240101.2"
      );

      await promote(prisma, environment.id, depV1.id);

      const resolver = makeResolver(prisma, false);
      const first = await resolver.resolveWorkerVersion({
        environmentId: environment.id,
        type: "PRODUCTION",
        taskIdentifier: "task-a",
      });
      expect(first?.worker.id).toBe(workerV1.id);

      await promote(prisma, environment.id, depV2.id);

      const afterPromotion = await resolver.resolveWorkerVersion({
        environmentId: environment.id,
        type: "PRODUCTION",
        taskIdentifier: "task-a",
      });
      expect(afterPromotion?.worker.id).toBe(workerV1.id);
    },
    30_000
  );
});
