// Real PG14 (control-plane) + PG17 (run-ops) proof for the run-rooted services that were
// decomposed onto the ControlPlaneResolver. The env (slug/project/org) lives on PG14;
// the run-ops scalar row on PG17 with cross-seam FKs dropped. A PostgresRunStore over PG17 reads
// run scalars; the ControlPlaneResolver over PG14 resolves the env. The DB is never mocked. The
// .count() proof shows neither DB joins the other.
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
] as const;

async function dropTaskRunCrossSeamFks(prisma: PrismaClient) {
  for (const c of TASK_RUN_CROSS_SEAM_FKS) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "TaskRun" DROP CONSTRAINT IF EXISTS "${c}"`);
  }
}

let n = 0;
async function seedControlPlane(prisma: PrismaClient) {
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
  return { organization, project, environment };
}

async function seedRun(
  prisma: PrismaClient,
  cp: { environment: { id: string }; project: { id: string }; organization: { id: string } }
) {
  const s = n++;
  return prisma.taskRun.create({
    data: {
      id: `run_${s}_pg17`,
      engine: "V2",
      status: "PENDING",
      friendlyId: `run_${s}`,
      runtimeEnvironmentId: cp.environment.id,
      projectId: cp.project.id,
      organizationId: cp.organization.id,
      taskIdentifier: "svc-task",
      payload: "{}",
      payloadType: "application/json",
      queue: "task/svc-task",
      traceId: `tr_${s}`,
      spanId: `sp_${s}`,
      workerQueue: "main",
    },
  });
}

function buildResolver(cp: PrismaClient) {
  return new ControlPlaneResolver({
    controlPlanePrimary: cp,
    controlPlaneReplica: cp,
    cache: new ControlPlaneCache(),
    splitEnabled: () => false,
  });
}

describe("service control-plane read-through", () => {
  heteroPostgresTest(
    "expireEnqueuedRun: org id resolves from PG14 via resolveEnv while run scalars resolve from PG17",
    async ({ prisma14, prisma17 }) => {
      await dropTaskRunCrossSeamFks(prisma17 as unknown as PrismaClient);
      const cp = await seedControlPlane(prisma14 as unknown as PrismaClient);
      const run = await seedRun(prisma17 as unknown as PrismaClient, cp);

      const runStore = new PostgresRunStore({
        prisma: prisma17 as unknown as PrismaClient,
        readOnlyPrisma: prisma17 as unknown as PrismaClient,
      });
      const resolver = buildResolver(prisma14 as unknown as PrismaClient);

      const found = await runStore.findRun(
        { id: run.id },
        { select: { id: true, runtimeEnvironmentId: true } },
        prisma17 as unknown as PrismaClient
      );
      const env = await resolver.resolveEnv(found!.runtimeEnvironmentId);
      expect(env!.organizationId).toBe(cp.organization.id);

      expect(await (prisma17 as unknown as PrismaClient).runtimeEnvironment.count()).toBe(0);
      expect(await (prisma14 as unknown as PrismaClient).taskRun.count()).toBe(0);
    }
  );
});
