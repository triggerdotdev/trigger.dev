// Replica-lag guards for the batch-service reads.
//
// Each case drives the REAL exported caller (a webapp service method that contains the run-store
// read) against a real Postgres testcontainer, with the store's read replica FROZEN via the shared
// `laggingReplica` primitive so a replica-routed read misses the just-written row while the primary
// still holds it. Only deps orthogonal to the read path are mocked (engine enqueue/count, env
// resolution, object-store download, id minting, control-plane env assertion, worker enqueue).
//
// Reads under guard (PostgresRunStore client-less defaults):
//   findBatchTaskRunById / findBatchTaskRunByIdempotencyKey / countBatchTaskRunItems → PRIMARY
//   findTaskRunAttempt → REPLICA (client ?? this.readOnlyPrisma)
//
// Property: the PRIMARY-routed reads observe the live row under lag (asserted on output) and
// wasHit(<model>) === false proves they never touched the frozen replica; the dependent-attempt
// read is threaded the primary client so it still sees a live terminal parent and the "parent
// already in a terminal state" guard fires.

import { heteroPostgresTest, laggingReplica } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// ---- Module mocks orthogonal to the run-store read path. -----------------------------------------
const dbHolder = vi.hoisted(() => ({ prisma: undefined as any }));
vi.mock("~/db.server", () => ({
  get prisma() {
    return dbHolder.prisma;
  },
  get $replica() {
    return dbHolder.prisma;
  },
}));
// Prevent the run engine + run-store singletons from constructing at import; every caller here is
// driven with an explicitly-injected store/engine, so these defaults are never used.
vi.mock("~/v3/runEngine.server", () => ({ engine: {} }));
vi.mock("~/v3/runStore.server", () => ({ runStore: {} }));
vi.mock("~/v3/batchTriggerWorker.server", () => ({
  batchTriggerWorker: { enqueue: vi.fn(async () => {}) },
}));
vi.mock("~/services/platform.v3.server", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getEntitlement: vi.fn(async () => ({ hasAccess: true })),
}));
// Env resolution is downstream of the batch read in both processBatchTaskRun callers.
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentById: vi.fn(async () => null),
}));
// Control-plane env existence assertion (batchTriggerV3.call preamble) — orthogonal to the reads.
vi.mock("~/v3/runOpsMigration/controlPlaneResolver.server", () => ({
  controlPlaneResolver: { assertEnvExists: vi.fn(async () => {}) },
}));
// Batch friendly-id minting — deterministic id so the created batch is predictable.
const mintHolder = vi.hoisted(() => ({ id: "", friendlyId: "" }));
vi.mock("~/v3/runOpsMigration/mintBatchFriendlyId.server", () => ({
  mintBatchFriendlyId: vi.fn(async () => ({
    id: mintHolder.id,
    friendlyId: mintHolder.friendlyId,
  })),
}));
// Object-store payload download for the existing-batch response (idempotency dedup path).
const objHolder = vi.hoisted(() => ({
  packet: { data: "[]", dataType: "application/json" } as { data?: string; dataType: string },
}));
vi.mock("~/v3/objectStore.server", () => ({
  downloadPacketFromObjectStore: vi.fn(async () => objHolder.packet),
  uploadPacketToObjectStore: vi.fn(async () => "uploaded"),
}));

import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
// REAL callers under guard.
import {
  BatchTriggerV3Service,
  tryCompleteBatchV3,
} from "../app/v3/services/batchTriggerV3.server";
import { StreamBatchItemsService } from "../app/runEngine/services/streamBatchItems.server";
import { RunEngineBatchTriggerService } from "../app/runEngine/services/batchTrigger.server";

let seq = 0;

async function seedTenant(prisma: PrismaClient, suffix: string) {
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
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  return { organization, project, environment };
}

// A PostgresRunStore whose PRIMARY is the live container and whose read replica is frozen for the
// given models (missing mode → replica-routed reads return null/[]/0). `wasHit(model)` proves whether
// a read actually consulted the frozen replica.
function storeWithFrozenReplica(prisma: PrismaClient, models: string[]) {
  const replica = laggingReplica(
    prisma,
    models.map((model) => ({ model, mode: "missing" as const }))
  );
  const store = new PostgresRunStore({
    prisma,
    readOnlyPrisma: replica.client,
    schemaVariant: "legacy",
  });
  return { store, replica };
}

async function createBatchOnPrimary(
  prisma: PrismaClient,
  params: {
    id: string;
    friendlyId: string;
    runtimeEnvironmentId: string;
    runCount: number;
    status?: "PENDING" | "PROCESSING" | "COMPLETED" | "PARTIAL_FAILED" | "ABORTED";
    sealed?: boolean;
    expectedCount?: number;
    runIds?: string[];
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date | null;
    payload?: string;
    payloadType?: string;
    processingCompletedAt?: Date | null;
  }
) {
  return prisma.batchTaskRun.create({
    data: {
      id: params.id,
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      runCount: params.runCount,
      expectedCount: params.expectedCount ?? params.runCount,
      status: params.status ?? "PENDING",
      sealed: params.sealed ?? false,
      runIds: params.runIds ?? [],
      batchVersion: "v3",
      idempotencyKey: params.idempotencyKey ?? null,
      idempotencyKeyExpiresAt: params.idempotencyKeyExpiresAt ?? null,
      payload: params.payload,
      payloadType: params.payloadType ?? "application/json",
      processingCompletedAt: params.processingCompletedAt ?? null,
    },
  });
}

// Seed a real TaskRun + a COMPLETED TaskRunAttempt (with its required FK graph) on the PRIMARY, whose
// parent run is in a FINAL status. Used to prove the dependent-attempt guard fires on a live row.
async function seedTerminalAttempt(
  prisma: PrismaClient,
  seed: { organization: { id: string }; project: { id: string }; environment: { id: string } },
  suffix: string
): Promise<{ attemptFriendlyId: string }> {
  const envId = seed.environment.id;
  const projectId = seed.project.id;

  const run = await prisma.taskRun.create({
    data: {
      friendlyId: `run_parent_${suffix}`,
      taskIdentifier: "parent-task",
      payload: "{}",
      payloadType: "application/json",
      traceId: `t_${suffix}`,
      spanId: `s_${suffix}`,
      runtimeEnvironmentId: envId,
      projectId,
      organizationId: seed.organization.id,
      environmentType: "DEVELOPMENT",
      queue: "task/parent-task",
      status: "COMPLETED_SUCCESSFULLY",
    },
  });

  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${suffix}`,
      contentHash: `hash_${suffix}`,
      projectId,
      runtimeEnvironmentId: envId,
      version: "20240101.1",
      metadata: {},
    },
  });
  const queue = await prisma.taskQueue.create({
    data: {
      friendlyId: `queue_${suffix}`,
      name: "task/parent-task",
      projectId,
      runtimeEnvironmentId: envId,
    },
  });
  const workerTask = await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: `wt_${suffix}`,
      slug: "parent-task",
      filePath: "src/trigger/parent.ts",
      workerId: worker.id,
      projectId,
      runtimeEnvironmentId: envId,
      queueId: queue.id,
    },
  });
  const attemptFriendlyId = `attempt_${suffix}`;
  await prisma.taskRunAttempt.create({
    data: {
      friendlyId: attemptFriendlyId,
      number: 1,
      taskRunId: run.id,
      backgroundWorkerId: worker.id,
      backgroundWorkerTaskId: workerTask.id,
      runtimeEnvironmentId: envId,
      queueId: queue.id,
      status: "COMPLETED",
    },
  });
  return { attemptFriendlyId };
}

async function* emptyItems() {
  // no items
}

// Minimal AuthenticatedEnvironment shape the traced callers read (attributesFromAuthenticatedEnv +
// the env-ownership check). Not the run-store read path — purely the tracing/ownership periphery.
function authEnv(seed: {
  organization: { id: string; slug: string; title: string };
  project: { id: string; name: string; slug: string };
  environment: { id: string };
}) {
  return {
    id: seed.environment.id,
    type: "DEVELOPMENT",
    slug: "dev",
    organizationId: seed.organization.id,
    projectId: seed.project.id,
    organization: {
      id: seed.organization.id,
      slug: seed.organization.slug,
      title: seed.organization.title,
      featureFlags: {},
    },
    project: { id: seed.project.id, name: seed.project.name, slug: seed.project.slug },
  };
}

describe("batch-svc — run-ops replica-lag guards", () => {
  // ================================================================================================
  // tryCompleteBatchV3 — findBatchTaskRunById + countBatchTaskRunItems (both PRIMARY-routed)
  // With the batch + its items frozen on the replica, the completion function reads both on the
  // primary, sees the sealed+fully-completed batch, and transitions it to COMPLETED.
  // ================================================================================================
  heteroPostgresTest(
    "tryCompleteBatchV3 completes a sealed batch whose row+items have not replicated (reads primary)",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      dbHolder.prisma = prisma;
      const suffix = `trycomplete_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      const { store, replica } = storeWithFrozenReplica(prisma, [
        "batchTaskRun",
        "batchTaskRunItem",
      ]);

      const { id: batchId, friendlyId } = BatchId.generate();
      await createBatchOnPrimary(prisma, {
        id: batchId,
        friendlyId,
        runtimeEnvironmentId: seed.environment.id,
        runCount: 2,
        expectedCount: 2,
        status: "PENDING",
        sealed: true,
      });

      // Two COMPLETED items on the primary (each needs a real TaskRun FK).
      for (const n of [1, 2]) {
        const run = await prisma.taskRun.create({
          data: {
            friendlyId: `run_${suffix}_${n}`,
            taskIdentifier: "child-task",
            payload: "{}",
            payloadType: "application/json",
            traceId: `t_${suffix}_${n}`,
            spanId: `s_${suffix}_${n}`,
            runtimeEnvironmentId: seed.environment.id,
            projectId: seed.project.id,
            organizationId: seed.organization.id,
            environmentType: "DEVELOPMENT",
            queue: "task/child-task",
            status: "COMPLETED_SUCCESSFULLY",
          },
        });
        await prisma.batchTaskRunItem.create({
          data: { batchTaskRunId: batchId, taskRunId: run.id, status: "COMPLETED" },
        });
      }

      await tryCompleteBatchV3(batchId, prisma as never, false, store);

      // The frozen replica was NEVER consulted for either read — both routed to the primary.
      expect(replica.wasHit("batchTaskRun")).toBe(false);
      expect(replica.wasHit("batchTaskRunItem")).toBe(false);

      // Observable outcome: the batch transitioned to COMPLETED with the full completed count. Had
      // either read hit the frozen replica, findBatchTaskRunById→null (early return, no transition) or
      // countBatchTaskRunItems→0 (< expectedCount, no transition).
      const finalBatch = await prisma.batchTaskRun.findFirstOrThrow({ where: { id: batchId } });
      expect(finalBatch.status).toBe("COMPLETED");
      expect(finalBatch.completedCount).toBe(2);
    }
  );

  // ================================================================================================
  // StreamBatchItemsService.call — initial findBatchTaskRunById (PRIMARY-routed)
  // The entry batch lookup reads the primary, finds the live PENDING batch (frozen on the replica),
  // and seals it — a replica-routed read would miss it.
  // ================================================================================================
  heteroPostgresTest(
    "streamBatchItems finds+seals a live batch whose row has not replicated (entry read → primary)",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      dbHolder.prisma = prisma;
      const suffix = `stream134_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      const { store, replica } = storeWithFrozenReplica(prisma, ["batchTaskRun"]);
      const { id: batchId, friendlyId } = BatchId.generate();
      await createBatchOnPrimary(prisma, {
        id: batchId,
        friendlyId,
        runtimeEnvironmentId: seed.environment.id,
        runCount: 0,
        status: "PENDING",
        sealed: false,
      });

      const fakeEngine = {
        runStore: store,
        getBatchEnqueuedCount: vi.fn(async () => 0),
        enqueueBatchItem: vi.fn(async () => ({ enqueued: true })),
      };
      const service = new StreamBatchItemsService({ engine: fakeEngine as never });

      const result = await service.call(authEnv(seed) as never, friendlyId, emptyItems(), {
        maxItemBytes: 1024,
        concurrency: 1,
      });

      expect(replica.wasHit("batchTaskRun")).toBe(false);
      expect(result.sealed).toBe(true);
      expect(result.id).toBe(friendlyId);
      // The primary write actually sealed the row.
      const sealed = await prisma.batchTaskRun.findFirstOrThrow({ where: { id: batchId } });
      expect(sealed.sealed).toBe(true);
      expect(sealed.status).toBe("PROCESSING");
    }
  );

  // ================================================================================================
  // StreamBatchItemsService.call — count-mismatch re-query findBatchTaskRunById (PRIMARY-routed)
  // A concurrent fast-completion marks the batch COMPLETED on the primary between the entry read and
  // the count check; the re-query reads the primary, sees COMPLETED, and returns sealed:true.
  // ================================================================================================
  heteroPostgresTest(
    "streamBatchItems count-mismatch re-query reads the primary (fast-completed batch → sealed:true)",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      dbHolder.prisma = prisma;
      const suffix = `stream206_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      const { store, replica } = storeWithFrozenReplica(prisma, ["batchTaskRun"]);
      const { id: batchId, friendlyId } = BatchId.generate();
      await createBatchOnPrimary(prisma, {
        id: batchId,
        friendlyId,
        runtimeEnvironmentId: seed.environment.id,
        runCount: 1,
        status: "PENDING",
        sealed: false,
      });

      const fakeEngine = {
        runStore: store,
        // Simulate the BatchQueue completing the batch on the PRIMARY before the count check, and
        // return a mismatched enqueued count so the caller takes the re-query branch.
        getBatchEnqueuedCount: vi.fn(async () => {
          await prisma.batchTaskRun.update({
            where: { id: batchId },
            data: { status: "COMPLETED", processingCompletedAt: new Date() },
          });
          return 0;
        }),
        enqueueBatchItem: vi.fn(async () => ({ enqueued: true })),
      };
      const service = new StreamBatchItemsService({ engine: fakeEngine as never });

      const result = await service.call(authEnv(seed) as never, friendlyId, emptyItems(), {
        maxItemBytes: 1024,
        concurrency: 1,
      });

      expect(replica.wasHit("batchTaskRun")).toBe(false);
      // Re-query found the COMPLETED batch on the primary → idempotent-retry success.
      expect(result.sealed).toBe(true);
      expect(result.id).toBe(friendlyId);
    }
  );

  // ================================================================================================
  // StreamBatchItemsService.call — seal-race re-query findBatchTaskRunById (PRIMARY-routed)
  // A concurrent request seals the batch (PROCESSING) on the primary before this request's
  // conditional seal, so the conditional update matches 0 rows; the re-query reads the primary, sees
  // PROCESSING, and returns sealed:true.
  // ================================================================================================
  heteroPostgresTest(
    "streamBatchItems seal-race re-query reads the primary (concurrently-sealed batch → sealed:true)",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      dbHolder.prisma = prisma;
      const suffix = `stream294_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      const { store, replica } = storeWithFrozenReplica(prisma, ["batchTaskRun"]);
      const { id: batchId, friendlyId } = BatchId.generate();
      await createBatchOnPrimary(prisma, {
        id: batchId,
        friendlyId,
        runtimeEnvironmentId: seed.environment.id,
        runCount: 0,
        status: "PENDING",
        sealed: false,
      });

      const fakeEngine = {
        runStore: store,
        // A concurrent request seals the batch on the PRIMARY before this request's conditional seal,
        // so the conditional update matches nothing and the caller takes the re-query branch.
        getBatchEnqueuedCount: vi.fn(async () => {
          await prisma.batchTaskRun.update({
            where: { id: batchId },
            data: { status: "PROCESSING", sealed: true, sealedAt: new Date() },
          });
          return 0;
        }),
        enqueueBatchItem: vi.fn(async () => ({ enqueued: true })),
      };
      const service = new StreamBatchItemsService({ engine: fakeEngine as never });

      const result = await service.call(authEnv(seed) as never, friendlyId, emptyItems(), {
        maxItemBytes: 1024,
        concurrency: 1,
      });

      expect(replica.wasHit("batchTaskRun")).toBe(false);
      // Re-query found the concurrently-sealed batch on the primary → sealed:true (no spurious throw).
      expect(result.sealed).toBe(true);
      expect(result.id).toBe(friendlyId);
    }
  );

  // ================================================================================================
  // RunEngineBatchTriggerService.processBatchTaskRun — findBatchTaskRunById (PRIMARY-routed)
  // The worker reads the just-written batch on the primary and proceeds to resolve its environment.
  // ================================================================================================
  heteroPostgresTest(
    "runEngine processBatchTaskRun reads the batch on the primary when the replica lags",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      dbHolder.prisma = prisma;
      const suffix = `retrigger_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      const { store, replica } = storeWithFrozenReplica(prisma, ["batchTaskRun"]);
      const { id: batchId, friendlyId } = BatchId.generate();
      await createBatchOnPrimary(prisma, {
        id: batchId,
        friendlyId,
        runtimeEnvironmentId: seed.environment.id,
        runCount: 1,
        status: "PENDING",
      });

      vi.mocked(findEnvironmentById).mockClear();
      vi.mocked(findEnvironmentById).mockResolvedValue(null as never);

      const fakeEngine = { runStore: store };
      const service = new RunEngineBatchTriggerService(
        "sequential",
        prisma as never,
        fakeEngine as never
      );

      await service.processBatchTaskRun({
        batchId,
        processingId: "0",
        range: { start: 0, count: 50 },
        attemptCount: 0,
        strategy: "sequential",
      });

      expect(replica.wasHit("batchTaskRun")).toBe(false);
      // The batch was found on the primary → env resolution was reached with the batch's env id. Had
      // the read hit the frozen replica the batch would be null and findEnvironmentById never called.
      expect(vi.mocked(findEnvironmentById)).toHaveBeenCalledWith(seed.environment.id);
    }
  );

  // ================================================================================================
  // BatchTriggerV3Service.processBatchTaskRun — findBatchTaskRunById (PRIMARY-routed)
  // Same property on the v3 worker path (injected runStore instead of an engine).
  // ================================================================================================
  heteroPostgresTest(
    "batchTriggerV3 processBatchTaskRun reads the batch on the primary when the replica lags",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      dbHolder.prisma = prisma;
      const suffix = `v3process_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      const { store, replica } = storeWithFrozenReplica(prisma, ["batchTaskRun"]);
      const { id: batchId, friendlyId } = BatchId.generate();
      await createBatchOnPrimary(prisma, {
        id: batchId,
        friendlyId,
        runtimeEnvironmentId: seed.environment.id,
        runCount: 1,
        status: "PENDING",
      });

      vi.mocked(findEnvironmentById).mockClear();
      vi.mocked(findEnvironmentById).mockResolvedValue(null as never);

      const service = new BatchTriggerV3Service(undefined, undefined, prisma as never, store);

      await service.processBatchTaskRun({
        batchId,
        processingId: "0",
        range: { start: 0, count: 50 },
        attemptCount: 0,
        strategy: "sequential",
      });

      expect(replica.wasHit("batchTaskRun")).toBe(false);
      expect(vi.mocked(findEnvironmentById)).toHaveBeenCalledWith(seed.environment.id);
    }
  );

  // ================================================================================================
  // BatchTriggerV3Service.call — findBatchTaskRunByIdempotencyKey (PRIMARY-routed)
  // The idempotency probe reads the primary, finds the just-written batch, and returns the cached
  // response — so no duplicate batch is triggered.
  // ================================================================================================
  heteroPostgresTest(
    "batchTriggerV3.call dedups on the primary when the just-written batch has not replicated",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      dbHolder.prisma = prisma;
      const suffix = `v3idem_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      const { store, replica } = storeWithFrozenReplica(prisma, ["batchTaskRun"]);
      const { id: batchId, friendlyId } = BatchId.generate();
      const idempotencyKey = `idem_${suffix}`;
      await createBatchOnPrimary(prisma, {
        id: batchId,
        friendlyId,
        runtimeEnvironmentId: seed.environment.id,
        runCount: 1,
        status: "COMPLETED",
        runIds: ["run_cached_1"],
        idempotencyKey,
        idempotencyKeyExpiresAt: null,
        payload: '[{"task":"my-task"}]',
        payloadType: "application/json",
      });
      objHolder.packet = { data: '[{"task":"my-task"}]', dataType: "application/json" };

      const environment = {
        id: seed.environment.id,
        organizationId: seed.organization.id,
        type: "DEVELOPMENT",
        organization: { id: seed.organization.id, featureFlags: {} },
        project: { id: seed.project.id },
      };
      const service = new BatchTriggerV3Service(
        undefined,
        undefined,
        prisma as never,
        store,
        (async () => "cuid") as never
      );

      const result = await service.call(
        environment as never,
        { items: [{ task: "my-task", payload: "{}", options: {} }] } as never,
        { idempotencyKey }
      );

      expect(replica.wasHit("batchTaskRun")).toBe(false);
      // The existing batch was found on the primary → returned as cached (no duplicate).
      expect(result.isCached).toBe(true);
      expect(result.id).toBe(friendlyId);
      expect(result.idempotencyKey).toBe(idempotencyKey);
    }
  );

  // ================================================================================================
  // BatchTriggerV3Service.call — findTaskRunAttempt (dependent-attempt read)
  // The dependent-attempt read is threaded the primary client, so under replica lag it still finds a
  // live TERMINAL parent attempt and the caller rejects the batch with a ServiceValidationError
  // ("parent already in a terminal state") rather than building a batch for a dead parent.
  // wasHit("taskRunAttempt") === false confirms the read hit the primary, not the frozen replica.
  // ================================================================================================
  heteroPostgresTest(
    "batchTriggerV3.call rejects a batch whose live terminal dependent-attempt has not replicated",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      dbHolder.prisma = prisma;
      const suffix = `v3dep_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      // The dependent (parent) attempt + its FINAL run live on the PRIMARY only.
      const { attemptFriendlyId } = await seedTerminalAttempt(prisma, seed, suffix);

      const { store, replica } = storeWithFrozenReplica(prisma, ["taskRunAttempt"]);
      mintHolder.id = `batch_${suffix}`;
      mintHolder.friendlyId = `batch_friendly_${suffix}`;

      const environment = {
        id: seed.environment.id,
        organizationId: seed.organization.id,
        type: "DEVELOPMENT",
        organization: { id: seed.organization.id, featureFlags: {} },
        project: { id: seed.project.id },
      };
      const service = new BatchTriggerV3Service(
        undefined,
        undefined,
        prisma as never,
        store,
        (async () => "cuid") as never
      );

      // The dependent-attempt read hits the primary, finds the live terminal attempt, and the caller
      // rejects — the frozen replica is never consulted for it.
      await expect(
        service.call(
          environment as never,
          {
            items: [{ task: "child-task", payload: "{}", options: {} }],
            dependentAttempt: attemptFriendlyId,
          } as never,
          {}
        )
      ).rejects.toThrow(/already in a terminal state/);

      // The dependent-attempt read hit the PRIMARY, never the frozen replica.
      expect(replica.wasHit("taskRunAttempt")).toBe(false);
    }
  );
});
