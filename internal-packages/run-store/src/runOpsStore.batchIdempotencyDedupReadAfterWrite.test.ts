// Property: the client-less batch idempotency dedup probe must resolve attempt-1's just-written batch
// from the OWNING store's WRITER, not its lagging replica. batchTriggerV3 dedups via
// findBatchTaskRunByIdempotencyKey(environment.id, idempotencyKey) with NO client, so through the
// router each leg resolves via the owning store's default. Seed attempt-1's batch on the owning WRITER,
// freeze that store's replica (mode "missing") on the real split topology (heteroRunOpsPostgresTest),
// issue the client-less probe, and assert it finds the batch with the replica never consulted — proven
// for BOTH residencies.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { RunStoreSchemaVariant } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// ownerEngine (classifyResidency) routes a run-ops v1 body → NEW, everything else → LEGACY.
const CUID_25 = "c".repeat(25); // → LEGACY (#legacy / prisma14, full schema)

// On the dedicated subset there are no Organization/Project/RuntimeEnvironment models (the run-ops
// rows carry FK-free scalar ids), so we mint synthetic owning ids. On legacy we seed the real rows
// the kept FKs require.
async function seedEnvironment(
  prisma: AnyClient,
  schemaVariant: RunStoreSchemaVariant,
  slugSuffix: string
) {
  if (schemaVariant === "dedicated") {
    return {
      organization: { id: `org_${slugSuffix}` },
      project: { id: `proj_${slugSuffix}` },
      environment: { id: `env_${slugSuffix}` },
    };
  }
  const organization = await (prisma as PrismaClient).organization.create({
    data: { title: `Org ${slugSuffix}`, slug: `org-${slugSuffix}` },
  });
  const project = await (prisma as PrismaClient).project.create({
    data: {
      name: `Project ${slugSuffix}`,
      slug: `project-${slugSuffix}`,
      externalRef: `proj_${slugSuffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await (prisma as PrismaClient).runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${slugSuffix}`,
      pkApiKey: `pk_dev_${slugSuffix}`,
      shortcode: `short_${slugSuffix}`,
    },
  });
  return { organization, project, environment };
}

// Seed attempt-1's batch (user-provided idempotencyKey) on the WRITER, exactly as batchTriggerV3's
// create arm would have written it on the first attempt.
async function seedBatch(
  store: PostgresRunStore,
  params: { id: string; friendlyId: string; environmentId: string; idempotencyKey: string }
) {
  await store.createBatchTaskRun({
    id: params.id,
    friendlyId: params.friendlyId,
    runtimeEnvironmentId: params.environmentId,
    idempotencyKey: params.idempotencyKey,
    idempotencyKeyExpiresAt: new Date(Date.now() + 60 * 60_000),
  });
}

describe("run-ops split — batch idempotency dedup reads the OWNING store's WRITER, not its lagging replica", () => {
  // The dedup probe issued by batchTriggerV3 on a RETRY:
  //   findBatchTaskRunByIdempotencyKey(environmentId, idempotencyKey)   // NO client
  // must resolve attempt-1's just-written batch, so the retry returns the cached batch instead of
  // triggering a duplicate one. Proven for BOTH residencies.

  // (a) LEGACY-resident (cuid) batch: attempt-1's batch was committed to the control-plane writer; the
  // control-plane replica lags. The client-less dedup must find it on the owning (legacy) store.
  heteroRunOpsPostgresTest(
    "LEGACY cuid: client-less dedup finds attempt-1's batch despite replica lag",
    async ({ prisma14, prisma17 }) => {
      const legacyReplica = laggingReplica(prisma14, [{ model: "batchTaskRun", mode: "missing" }]);
      const legacyStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: legacyReplica.client,
        schemaVariant: "legacy",
      });
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: prisma17 as never,
        schemaVariant: "dedicated",
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed = await seedEnvironment(prisma14, "legacy", "batch_leg");
      const idempotencyKey = "batch-idem-legacy";
      await seedBatch(legacyStore, {
        id: `batch_${CUID_25}`, // cuid → LEGACY
        friendlyId: "batch_batch_leg",
        environmentId: seed.environment.id,
        idempotencyKey,
      });

      // The exact dedup probe: no client.
      const found = await router.findBatchTaskRunByIdempotencyKey(
        seed.environment.id,
        idempotencyKey
      );

      // Resolved on the owning store's writer; the lagging replica must never be consulted.
      expect(found).not.toBeNull();
      expect(found!.idempotencyKey).toBe(idempotencyKey);
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(false);
    }
  );

  // (b) NEW-resident (run-ops id) batch on the dedicated subset schema: the NEW replica lags. The
  // client-less dedup must resolve on the NEW writer.
  heteroRunOpsPostgresTest(
    "NEW run-ops id: client-less dedup finds attempt-1's batch despite NEW replica lag",
    async ({ prisma14, prisma17 }) => {
      const newReplica = laggingReplica(prisma17, [{ model: "batchTaskRun", mode: "missing" }]);
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: newReplica.client as never,
        schemaVariant: "dedicated",
      });
      const legacyStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: prisma14,
        schemaVariant: "legacy",
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed = await seedEnvironment(prisma17, "dedicated", "batch_new");
      const idempotencyKey = "batch-idem-new";
      await seedBatch(newStore, {
        id: `batch_${generateRunOpsId()}`, // run-ops id → NEW
        friendlyId: "batch_batch_new",
        environmentId: seed.environment.id,
        idempotencyKey,
      });

      const found = await router.findBatchTaskRunByIdempotencyKey(
        seed.environment.id,
        idempotencyKey
      );

      expect(found).not.toBeNull();
      expect(found!.idempotencyKey).toBe(idempotencyKey);
      expect(newReplica.wasHit("batchTaskRun")).toBe(false);
    }
  );
});
