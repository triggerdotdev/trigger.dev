// Real PG14 (control-plane) + PG17 (run-ops) proof for findEnvironmentFromRun.
// The env (slug/project/org) lives on PG14; the run-ops scalar row on PG17 with cross-seam
// FKs dropped. A PostgresRunStore over PG17 reads run scalars; the ControlPlaneResolver over
// PG14 resolves the env. The DB is never mocked. The .count() proof shows neither DB joins
// the other.
import { heteroPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { ControlPlaneCache } from "~/v3/runOpsMigration/controlPlaneCache.server";
import { ControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const TASK_RUN_CROSS_SEAM_FKS = [
  "TaskRun_runtimeEnvironmentId_fkey",
  "TaskRun_projectId_fkey",
  "TaskRun_organizationId_fkey",
] as const;

async function dropTaskRunCrossSeamFks(prisma: PrismaClient) {
  for (const constraint of TASK_RUN_CROSS_SEAM_FKS) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "TaskRun" DROP CONSTRAINT IF EXISTS "${constraint}"`
    );
  }
}

let seedCounter = 0;

async function seedControlPlane(prisma: PrismaClient) {
  const n = seedCounter++;
  const organization = await prisma.organization.create({
    data: { title: `Org ${n}`, slug: `org-${n}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${n}`,
      slug: `project-${n}`,
      externalRef: `proj_${n}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: `env-${n}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${n}`,
      pkApiKey: `pk_prod_${n}`,
      shortcode: `short_${n}`,
    },
  });
  return { organization, project, environment };
}

async function seedRun(
  prisma: PrismaClient,
  ids: { runtimeEnvironmentId: string; projectId: string; organizationId: string },
  opts?: { runTags?: string[] }
) {
  const n = seedCounter++;
  return prisma.taskRun.create({
    data: {
      id: `run_${n}_pg17`,
      engine: "V2",
      status: "PENDING",
      friendlyId: `run_friendly_${n}`,
      runtimeEnvironmentId: ids.runtimeEnvironmentId,
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      taskIdentifier: "fefr-task",
      payload: "{}",
      payloadType: "application/json",
      queue: "task/fefr-task",
      traceId: `trace_${n}`,
      spanId: `span_${n}`,
      workerQueue: "main",
      runTags: opts?.runTags ?? ["a", "b"],
    },
  });
}

function buildResolver(controlPlane: PrismaClient) {
  return new ControlPlaneResolver({
    controlPlanePrimary: controlPlane,
    controlPlaneReplica: controlPlane,
    cache: new ControlPlaneCache({ ttlMs: 60_000, maxEntries: 100 }),
    splitEnabled: () => false,
  });
}

describe("findEnvironmentFromRun cross-DB read-through", () => {
  heteroPostgresTest(
    "resolves env from PG14 while run scalars resolve from PG17 (no cross-DB join)",
    async ({ prisma14, prisma17 }) => {
      await dropTaskRunCrossSeamFks(prisma17 as unknown as PrismaClient);
      const cp = await seedControlPlane(prisma14 as unknown as PrismaClient);
      const run = await seedRun(
        prisma17 as unknown as PrismaClient,
        {
          runtimeEnvironmentId: cp.environment.id,
          projectId: cp.project.id,
          organizationId: cp.organization.id,
        },
        { runTags: ["x", "y"] }
      );

      const runStore = new PostgresRunStore({
        prisma: prisma17 as unknown as PrismaClient,
        readOnlyPrisma: prisma17 as unknown as PrismaClient,
      });
      const resolver = buildResolver(prisma14 as unknown as PrismaClient);

      // The decomposed findEnvironmentFromRun: run scalars from the store + env from the resolver.
      const taskRun = await runStore.findRun(
        { id: run.id },
        { select: { runtimeEnvironmentId: true, runTags: true, batchId: true } },
        prisma17 as unknown as PrismaClient
      );
      expect(taskRun).not.toBeNull();
      const environment = await resolver.resolveAuthenticatedEnv(taskRun!.runtimeEnvironmentId);
      expect(environment).not.toBeNull();
      expect(environment!.id).toBe(cp.environment.id);
      expect(environment!.slug).toBe(cp.environment.slug);
      expect(environment!.project.id).toBe(cp.project.id);
      expect(taskRun!.runTags).toEqual(["x", "y"]);

      // Inversion proof: PG17 (run-ops) has no env rows; PG14 (control-plane) has no run rows.
      expect(await (prisma17 as unknown as PrismaClient).runtimeEnvironment.count()).toBe(0);
      expect(await (prisma14 as unknown as PrismaClient).taskRun.count()).toBe(0);
    }
  );
});
