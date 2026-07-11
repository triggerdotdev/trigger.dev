import { assertNonNullable, heteroPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import { PassthroughControlPlaneResolver } from "../controlPlaneResolver.js";
import { PostgresRunStore } from "@internal/run-store";

vi.setConfig({ testTimeout: 60_000 });

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

async function seedEnv(prisma: PrismaClient, suffix: string) {
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
      type: "PRODUCTION",
      slug: `prod-${suffix}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_${suffix}`,
      pkApiKey: `pk_${suffix}`,
      shortcode: `short_${suffix}`,
      maximumConcurrencyLimit: 10,
    },
  });
  return { organization, project, environment };
}

describe("engine residual inversions controlPlaneResolver (hetero cross-DB)", () => {
  heteroPostgresTest(
    "resolveEnv covers ttl + parkPendingVersion env reads from the control-plane DB while runs live on the run-ops DB",
    async ({ prisma14, prisma17 }) => {
      await dropTaskRunCrossSeamFks(prisma17 as unknown as PrismaClient);
      const cp = await seedEnv(prisma14 as unknown as PrismaClient, "resid");

      const runStore = new PostgresRunStore({
        prisma: prisma17 as unknown as PrismaClient,
        readOnlyPrisma: prisma17 as unknown as PrismaClient,
      });
      const resolver = new PassthroughControlPlaneResolver({
        prisma: prisma14 as unknown as PrismaClient,
      });

      await (prisma17 as unknown as PrismaClient).taskRun.create({
        data: {
          id: "run_resid",
          engine: "V2",
          status: "PENDING",
          friendlyId: "run_friendly_resid",
          runtimeEnvironmentId: cp.environment.id,
          organizationId: cp.organization.id,
          projectId: cp.project.id,
          taskIdentifier: "resid-task",
          payload: "{}",
          payloadType: "application/json",
          queue: "task/resid-task",
          traceId: "trace_resid",
          spanId: "span_resid",
        },
      });

      const run = await runStore.findRun(
        { id: "run_resid" },
        { select: { id: true, runtimeEnvironmentId: true } }
      );
      assertNonNullable(run);
      const env = await resolver.resolveEnv(run.runtimeEnvironmentId);
      assertNonNullable(env);
      // ttl reads organizationId/projectId/id; parkPendingVersion reads id/type/projectId/project.organizationId.
      expect(env.id).toBe(cp.environment.id);
      expect(env.type).toBe("PRODUCTION");
      expect(env.organizationId).toBe(cp.organization.id);
      expect(env.projectId).toBe(cp.project.id);

      expect(await (prisma17 as unknown as PrismaClient).runtimeEnvironment.count()).toBe(0);
      expect(await (prisma14 as unknown as PrismaClient).taskRun.count()).toBe(0);
    }
  );
});
