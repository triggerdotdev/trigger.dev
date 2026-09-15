import { heteroPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { ControlPlaneCache } from "~/v3/runOpsMigration/controlPlaneCache.server";
import { ControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";

vi.setConfig({ testTimeout: 60_000 });

const TASK_RUN_CROSS_SEAM_FKS = [
  "TaskRun_runtimeEnvironmentId_fkey",
  "TaskRun_projectId_fkey",
  "TaskRun_organizationId_fkey",
  // lockedBy/lockedToVersion point at control-plane rows (BackgroundWorkerTask /
  // BackgroundWorker) that live only on PG14 — drop their FKs on the PG17 run-ops DB.
  "TaskRun_lockedById_fkey",
  "TaskRun_lockedToVersionId_fkey",
] as const;

async function dropTaskRunCrossSeamFks(prisma: PrismaClient) {
  for (const constraint of TASK_RUN_CROSS_SEAM_FKS) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "TaskRun" DROP CONSTRAINT IF EXISTS "${constraint}"`
    );
  }
}

let n = 0;
async function seedControlPlaneWithWorker(prisma: PrismaClient) {
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
      sdkVersion: "3.0.0",
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
  return { organization, project, environment, worker, task };
}

describe("SpanPresenter cross-DB read-through", () => {
  heteroPostgresTest(
    "env + lockedToVersion + lockedBy resolve from PG14 while run scalars resolve from PG17",
    async ({ prisma14, prisma17 }) => {
      await dropTaskRunCrossSeamFks(prisma17 as unknown as PrismaClient);
      const cp = await seedControlPlaneWithWorker(prisma14 as unknown as PrismaClient);

      const _run = await (prisma17 as unknown as PrismaClient).taskRun.create({
        data: {
          id: `run_${n++}_pg17`,
          engine: "V2",
          status: "COMPLETED_SUCCESSFULLY",
          friendlyId: `run_sp_${n}`,
          runtimeEnvironmentId: cp.environment.id,
          organizationId: cp.organization.id,
          projectId: cp.project.id,
          lockedById: cp.task.id,
          lockedToVersionId: cp.worker.id,
          taskIdentifier: "sp-task",
          payload: "{}",
          payloadType: "application/json",
          queue: "task/sp-task",
          traceId: "trace_sp",
          spanId: "span_sp",
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
        { spanId: "span_sp", runtimeEnvironmentId: cp.environment.id },
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
      expect(found).not.toBeNull();

      const env = await resolver.resolveAuthenticatedEnv(found!.runtimeEnvironmentId);
      expect(env!.id).toBe(cp.environment.id);
      // AuthenticatedEnvironment carries org at the TOP LEVEL (env.organization), not under
      // project — the decomposed SpanPresenter reads env.organization.{id,slug,title}.
      expect(env!.organization.title).toBe(cp.organization.title);
      expect(env!.project.externalRef).toBe(cp.project.externalRef);

      const locked = await resolver.resolveRunLockedWorker({
        lockedById: found!.lockedById,
        lockedToVersionId: found!.lockedToVersionId,
      });
      expect(locked!.lockedBy!.filePath).toBe("src/index.ts");
      expect(locked!.lockedToVersion!.version).toBe(cp.worker.version);
      expect(locked!.lockedToVersion!.sdkVersion).toBe("3.0.0");

      expect(await (prisma17 as unknown as PrismaClient).runtimeEnvironment.count()).toBe(0);
      expect(await (prisma14 as unknown as PrismaClient).taskRun.count()).toBe(0);
    }
  );
});
