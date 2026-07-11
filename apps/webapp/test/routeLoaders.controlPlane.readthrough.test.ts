// Real PG14 (control-plane) + PG17 (run-ops) proof for the run route loaders that were
// decomposed onto the ControlPlaneResolver. The env (slug/project/org) and the
// locked worker/deployment live on PG14; the run-ops scalar row on PG17 with cross-seam FKs
// dropped (including the lockedById / lockedToVersionId FKs). A PostgresRunStore over PG17
// reads run scalars; the ControlPlaneResolver over PG14 resolves env + lockedBy.worker.deployment.
// The DB is never mocked. The .count() proof shows neither DB joins the other.
import { heteroPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { ControlPlaneCache } from "~/v3/runOpsMigration/controlPlaneCache.server";
import { ControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const TASK_RUN_CROSS_SEAM_FKS = [
  "TaskRun_runtimeEnvironmentId_fkey",
  "TaskRun_projectId_fkey",
  "TaskRun_organizationId_fkey",
  "TaskRun_lockedById_fkey",
  "TaskRun_lockedToVersionId_fkey",
] as const;

async function dropTaskRunCrossSeamFks(prisma: PrismaClient) {
  for (const c of TASK_RUN_CROSS_SEAM_FKS) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "TaskRun" DROP CONSTRAINT IF EXISTS "${c}"`);
  }
}

let n = 0;
async function seedAll(prisma: PrismaClient) {
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
      type: "PRODUCTION",
      slug: `env-${s}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_${s}`,
      pkApiKey: `pk_${s}`,
      shortcode: `sc_${s}`,
    },
  });
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${s}`,
      contentHash: `hash_${s}`,
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
      version: `2024.1.${s}`,
      metadata: {},
      engine: "V2",
    },
  });
  const deployment = await prisma.workerDeployment.create({
    data: {
      friendlyId: `dep_${s}`,
      contentHash: `hash_${s}`,
      version: worker.version,
      shortCode: `dc_${s}`,
      type: "MANAGED",
      status: "DEPLOYED",
      projectId: project.id,
      environmentId: environment.id,
      workerId: worker.id,
      git: { commitSha: `sha_${s}` },
    },
  });
  const task = await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: `task_${s}`,
      slug: `t-${s}`,
      filePath: "src/index.ts",
      exportName: "myTask",
      workerId: worker.id,
      runtimeEnvironmentId: environment.id,
      projectId: project.id,
    },
  });
  return { organization, project, environment, worker, deployment, task };
}

describe("run route loader cross-DB read-through", () => {
  heteroPostgresTest(
    "resources.runs.$runParam env + lockedBy.worker.deployment.git resolve from PG14",
    async ({ prisma14, prisma17 }) => {
      await dropTaskRunCrossSeamFks(prisma17 as unknown as PrismaClient);
      const cp = await seedAll(prisma14 as unknown as PrismaClient);

      const run = await (prisma17 as unknown as PrismaClient).taskRun.create({
        data: {
          id: `run_${n++}_pg17`,
          engine: "V2",
          status: "COMPLETED_SUCCESSFULLY",
          friendlyId: `run_rl_${n}`,
          runtimeEnvironmentId: cp.environment.id,
          projectId: cp.project.id,
          organizationId: cp.organization.id,
          lockedById: cp.task.id,
          lockedToVersionId: cp.worker.id,
          taskIdentifier: "rl-task",
          payload: "{}",
          payloadType: "application/json",
          queue: "task/rl-task",
          traceId: "tr_rl",
          spanId: "sp_rl",
          workerQueue: "main",
        },
      });

      const runStore = new PostgresRunStore({
        prisma: prisma17 as unknown as PrismaClient,
        readOnlyPrisma: prisma17 as unknown as PrismaClient,
      });
      const resolver = new ControlPlaneResolver({
        controlPlanePrimary: prisma14 as unknown as PrismaClient,
        controlPlaneReplica: prisma14 as unknown as PrismaClient,
        cache: new ControlPlaneCache(),
        splitEnabled: () => false,
      });

      const found = await runStore.findRun(
        { friendlyId: run.friendlyId },
        {
          select: {
            id: true,
            runtimeEnvironmentId: true,
            lockedById: true,
            lockedToVersionId: true,
          },
        },
        prisma17 as unknown as PrismaClient
      );
      const env = await resolver.resolveAuthenticatedEnv(found!.runtimeEnvironmentId);
      expect(env!.slug).toBe(cp.environment.slug);
      expect(env!.organization.title).toBe(cp.organization.title);
      expect(env!.project.externalRef).toBe(cp.project.externalRef);

      const locked = await resolver.resolveRunLockedWorker({
        lockedById: found!.lockedById,
        lockedToVersionId: found!.lockedToVersionId,
      });
      expect(locked!.lockedToVersion!.version).toBe(cp.worker.version);
      expect(locked!.lockedBy!.worker.deployment!.git).toEqual({
        commitSha: cp.deployment.git ? (cp.deployment.git as any).commitSha : undefined,
      });
      expect(locked!.lockedBy!.worker.deployment!.friendlyId).toBe(cp.deployment.friendlyId);

      expect(await (prisma17 as unknown as PrismaClient).runtimeEnvironment.count()).toBe(0);
      expect(await (prisma14 as unknown as PrismaClient).taskRun.count()).toBe(0);
    }
  );
});
