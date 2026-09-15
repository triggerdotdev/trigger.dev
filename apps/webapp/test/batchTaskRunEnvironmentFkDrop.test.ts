// Proof for dropping the canonical BatchTaskRun -> RuntimeEnvironment FK
// (constraint "BatchTaskRun_runtimeEnvironmentId_fkey", onDelete: Cascade) while keeping the
// runtimeEnvironmentId scalar and its compound @@unique/@@index. BatchTaskRun is run-ops and
// RuntimeEnvironment is control-plane, so the two may live on different servers; create-time
// integrity is preserved app-side via the ControlPlaneResolver's assertEnvExists. Env-delete
// orphan cleanup is handled separately — here the batch row is tolerated.

import { heteroPostgresTest, postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { ControlPlaneCache } from "~/v3/runOpsMigration/controlPlaneCache.server";
import {
  ControlPlaneReferenceError,
  ControlPlaneResolver,
} from "~/v3/runOpsMigration/controlPlaneResolver.server";

// Cross-DB testcontainer spin-up + queries can exceed the 5s default on the first test.
vi.setConfig({ testTimeout: 60_000 });

let seedCounter = 0;

async function seedEnvironment(prisma: PrismaClient) {
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

let batchCounter = 0;

async function createBatch(prisma: PrismaClient, runtimeEnvironmentId: string) {
  const n = batchCounter++;
  return prisma.batchTaskRun.create({
    data: {
      friendlyId: `batch_${n}`,
      runtimeEnvironmentId,
      runCount: 1,
      runIds: [],
      batchVersion: "runengine:v2",
    },
  });
}

// Asserts the post-migration state of BatchTaskRun on a given client: the FK is gone, but the
// scalar and both compound constraints are retained. Shared by the single-version and the
// cross-version suites.
async function assertSchemaState(prisma: PrismaClient) {
  const foreignKeys = await prisma.$queryRaw<{ constraint_name: string }[]>`
    SELECT constraint_name
    FROM information_schema.table_constraints
    WHERE table_name = 'BatchTaskRun'
      AND constraint_type = 'FOREIGN KEY'
  `;
  expect(foreignKeys.map((c) => c.constraint_name)).not.toContain(
    "BatchTaskRun_runtimeEnvironmentId_fkey"
  );

  const columns = await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'BatchTaskRun'
      AND column_name = 'runtimeEnvironmentId'
  `;
  expect(columns).toHaveLength(1);

  // The @@unique([runtimeEnvironmentId, idempotencyKey]) and
  // @@index([runtimeEnvironmentId, id(sort: Desc)]) both survive the FK drop.
  const indexes = await prisma.$queryRaw<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE tablename = 'BatchTaskRun'
  `;
  const defs = indexes.map((i) => i.indexdef);
  const hasUnique = defs.some(
    (d) => /UNIQUE/i.test(d) && d.includes("runtimeEnvironmentId") && d.includes("idempotencyKey")
  );
  const hasIndex = defs.some(
    (d) => !/UNIQUE/i.test(d) && d.includes("runtimeEnvironmentId") && /\bid\b/.test(d)
  );
  expect(hasUnique).toBe(true);
  expect(hasIndex).toBe(true);
}

// Inserts an env + batch, deletes the env, and asserts the batch survives (cascade gone).
async function assertOrphanTolerated(prisma: PrismaClient) {
  const { environment } = await seedEnvironment(prisma);
  const batch = await createBatch(prisma, environment.id);

  await prisma.runtimeEnvironment.delete({ where: { id: environment.id } });

  const survivor = await prisma.batchTaskRun.findFirst({ where: { id: batch.id } });
  expect(survivor).not.toBeNull();
  expect(survivor?.runtimeEnvironmentId).toBe(environment.id);
}

describe("drop BatchTaskRun -> RuntimeEnvironment FK", () => {
  postgresTest("FK constraint absent; scalar + unique + index retained", async ({ prisma }) => {
    await assertSchemaState(prisma);
  });

  postgresTest(
    "deleting the env leaves the BatchTaskRun row alive (no cascade; orphan cleanup handled separately)",
    async ({ prisma }) => {
      await assertOrphanTolerated(prisma);
    }
  );

  postgresTest(
    "app-side env validation: assertEnvExists rejects an invalid env and a valid-env create succeeds by scalar",
    async ({ prisma }) => {
      const { environment } = await seedEnvironment(prisma);

      const resolver = new ControlPlaneResolver({
        controlPlanePrimary: prisma,
        controlPlaneReplica: prisma,
        cache: new ControlPlaneCache(),
        splitEnabled: () => true,
      });

      // The exact guard call the create services place before batchTaskRun.create.
      await expect(resolver.assertEnvExists("env_does_not_exist")).rejects.toBeInstanceOf(
        ControlPlaneReferenceError
      );

      await expect(resolver.assertEnvExists(environment.id)).resolves.toBeUndefined();

      // Once the guard passes, the batch is linked by the runtimeEnvironmentId scalar (no FK).
      const batch = await createBatch(prisma, environment.id);
      expect(batch.runtimeEnvironmentId).toBe(environment.id);
    }
  );
});

// Cross-version gate: the migration applies and the post-state is identical across major versions.
describe("drop BatchTaskRun -> RuntimeEnvironment FK — cross-version (legacy + new Postgres)", () => {
  heteroPostgresTest(
    "migration applies and FK is absent on both the legacy and new databases",
    async ({ prisma14, prisma17 }) => {
      await assertSchemaState(prisma14);
      await assertSchemaState(prisma17);
    }
  );

  heteroPostgresTest(
    "env delete leaves the batch orphaned on both the legacy and new databases",
    async ({ prisma14, prisma17 }) => {
      await assertOrphanTolerated(prisma14);
      await assertOrphanTolerated(prisma17);
    }
  );
});
