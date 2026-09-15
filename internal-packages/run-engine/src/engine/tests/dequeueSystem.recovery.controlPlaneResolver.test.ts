import { assertNonNullable, heteroRunOpsPostgresTest } from "@internal/testcontainers";
import { sanitizeQueueName } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import { PassthroughControlPlaneResolver } from "../controlPlaneResolver.js";
import { PostgresRunStore } from "@internal/run-store";

vi.setConfig({ testTimeout: 60_000 });

async function seedControlPlane(prisma: PrismaClient, suffix: string, taskSlug: string) {
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
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: `short_${suffix}`,
      maximumConcurrencyLimit: 10,
    },
  });
  const queueName = sanitizeQueueName(`task/${taskSlug}`);
  return { organization, project, environment, queueName };
}

describe("DequeueSystem recovery controlPlaneResolver (hetero cross-DB, dedicated run-ops client)", () => {
  heteroRunOpsPostgresTest(
    "the nack/requeue recovery read resolves env via the resolver and never reads a null run.runtimeEnvironment relation",
    async ({ prisma14, prisma17 }) => {
      const taskSlug = "test-task";

      // The dedicated run-ops schema has NO control-plane tables and NO cross-seam FKs, so there is
      // nothing to drop on prisma17. Control-plane rows are seeded on PG14 only.
      const cp = await seedControlPlane(prisma14 as unknown as PrismaClient, "recov", taskSlug);

      const runId = "run_recov_pg17";
      await prisma17.taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "PENDING",
          friendlyId: "run_friendly_recov",
          // scalar control-plane FK ids — no control-plane row exists on the dedicated DB.
          runtimeEnvironmentId: cp.environment.id,
          organizationId: cp.organization.id,
          projectId: cp.project.id,
          taskIdentifier: taskSlug,
          payload: "{}",
          payloadType: "application/json",
          queue: cp.queueName,
          traceId: "trace_recov",
          spanId: "span_recov",
        },
      });

      const runStore = new PostgresRunStore({
        prisma: prisma17 as unknown as PrismaClient,
        readOnlyPrisma: prisma17 as unknown as PrismaClient,
        schemaVariant: "dedicated",
      });
      const resolver = new PassthroughControlPlaneResolver({
        prisma: prisma14 as unknown as PrismaClient,
      });

      // Regression guard: an include-based read of the control-plane `runtimeEnvironment` relation
      // is invalid on the dedicated subset client (the relation does not exist there), so it throws.
      await expect(
        runStore.findRun({ id: runId }, { include: { runtimeEnvironment: true } })
      ).rejects.toThrow();

      // Fixed shape: scalars-only select resolved from the dedicated run-ops client + resolveEnv
      // against PG14.
      const run = await runStore.findRun(
        { id: runId },
        { select: { id: true, runtimeEnvironmentId: true, projectId: true } }
      );
      assertNonNullable(run);
      expect(run.id).toBe(runId);
      expect(run.runtimeEnvironmentId).toBe(cp.environment.id);
      expect(run.projectId).toBe(cp.project.id);

      const env = await resolver.resolveEnv(run.runtimeEnvironmentId);
      assertNonNullable(env);
      expect(env.id).toBe(cp.environment.id);
      expect(env.type).toBe("PRODUCTION");
      expect(run.projectId).toBe(env.projectId);

      // Inversion proof: no run on PG14 (control-plane).
      expect(await (prisma14 as unknown as PrismaClient).taskRun.count()).toBe(0);
    }
  );
});
