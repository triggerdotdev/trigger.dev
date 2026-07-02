import { heteroPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import type { ReadClient, RunStore } from "@internal/run-store";
import type { Prisma, PrismaClient } from "@trigger.dev/database";
import { parsePacket } from "@trigger.dev/core/v3";
import { generateKsuidId } from "@trigger.dev/core/v3/isomorphic";
import { setTimeout } from "timers/promises";
import { describe, expect } from "vitest";
import { UpdateMetadataService } from "~/services/metadata/updateMetadata.server";

vi.setConfig({ testTimeout: 60_000 });

/**
 * A test-only RunStore that routes residency-bearing operations to one of two
 * inner PostgresRunStore instances (NEW = PG17, LEGACY = PG14) purely by run-id
 * classification — NOT by whatever client the service forwards as `tx`.
 *
 * This is the load-bearing design point: the UpdateMetadataService forwards
 * `this._prisma` as the tx/client to every findRun/updateMetadata call. To prove
 * STORE residency routing (and not the forwarded prisma), this wrapper IGNORES
 * the forwarded client for residency-bearing calls and resolves to its own inner
 * store by id length, then calls the inner store WITHOUT forwarding the outer tx
 * (passes undefined), so the inner PostgresRunStore uses its own prisma17/prisma14.
 *
 * Classification contract (length-disjoint): 27-char id => KSUID => NEW store;
 * 25-char cuid => LEGACY store.
 */
class RoutingRunStore implements RunStore {
  readonly #newStore: PostgresRunStore;
  readonly #legacyStore: PostgresRunStore;

  constructor(newStore: PostgresRunStore, legacyStore: PostgresRunStore) {
    this.#newStore = newStore;
    this.#legacyStore = legacyStore;
  }

  // Resolve by run-id length: 27 => NEW (KSUID), otherwise LEGACY (25-char cuid).
  #resolveById(runId: string): PostgresRunStore {
    return runId.length === 27 ? this.#newStore : this.#legacyStore;
  }

  // Extract a classifiable run id from a `where`. Prefers `where.id`; if only a
  // friendlyId is present we cannot classify by length, so the caller falls back
  // to read-through (try NEW, then LEGACY).
  #idFromWhere(where: Prisma.TaskRunWhereInput): string | undefined {
    const id = (where as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }

  // ---- Reads (residency routing; drop forwarded client) ----

  async findRun(
    where: Prisma.TaskRunWhereInput,
    argsOrClient?: { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude } | ReadClient,
    _client?: ReadClient
  ): Promise<unknown> {
    const id = this.#idFromWhere(where);
    if (id !== undefined) {
      // Classifiable by id length — route to the owning store, dropping the
      // forwarded client so the inner store uses its OWN prisma.
      return (this.#resolveById(id).findRun as any)(where, argsOrClient);
    }
    // Not classifiable (friendlyId-only / other) — read-through: NEW then LEGACY.
    const fromNew = await (this.#newStore.findRun as any)(where, argsOrClient);
    if (fromNew) {
      return fromNew;
    }
    return (this.#legacyStore.findRun as any)(where, argsOrClient);
  }

  async findRunOrThrow(
    where: Prisma.TaskRunWhereInput,
    argsOrClient?: { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude } | ReadClient,
    _client?: ReadClient
  ): Promise<unknown> {
    const id = this.#idFromWhere(where);
    if (id !== undefined) {
      return (this.#resolveById(id).findRunOrThrow as any)(where, argsOrClient);
    }
    const fromNew = await (this.#newStore.findRun as any)(where, argsOrClient);
    if (fromNew) {
      return fromNew;
    }
    return (this.#legacyStore.findRunOrThrow as any)(where, argsOrClient);
  }

  async findRunOnPrimary(
    where: Prisma.TaskRunWhereInput,
    args?: { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude }
  ): Promise<unknown> {
    const id = this.#idFromWhere(where);
    if (id !== undefined) {
      return (this.#resolveById(id).findRunOnPrimary as any)(where, args);
    }
    const fromNew = await (this.#newStore.findRunOnPrimary as any)(where, args);
    if (fromNew) {
      return fromNew;
    }
    return (this.#legacyStore.findRunOnPrimary as any)(where, args);
  }

  async findRunOrThrowOnPrimary(
    where: Prisma.TaskRunWhereInput,
    args?: { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude }
  ): Promise<unknown> {
    const id = this.#idFromWhere(where);
    if (id !== undefined) {
      return (this.#resolveById(id).findRunOrThrowOnPrimary as any)(where, args);
    }
    const fromNew = await (this.#newStore.findRunOnPrimary as any)(where, args);
    if (fromNew) {
      return fromNew;
    }
    return (this.#legacyStore.findRunOrThrowOnPrimary as any)(where, args);
  }

  async findRuns(
    args: { where: Prisma.TaskRunWhereInput },
    _client?: ReadClient
  ): Promise<unknown> {
    const id = this.#idFromWhere(args.where);
    if (id !== undefined) {
      return (this.#resolveById(id).findRuns as any)(args);
    }
    // Read-through across both stores, NEW first.
    const fromNew = (await (this.#newStore.findRuns as any)(args)) as unknown[];
    const fromLegacy = (await (this.#legacyStore.findRuns as any)(args)) as unknown[];
    return [...fromNew, ...fromLegacy];
  }

  // ---- Field touches (residency routing; drop forwarded tx) ----

  async updateMetadata(
    runId: string,
    data: Parameters<RunStore["updateMetadata"]>[1],
    options: Parameters<RunStore["updateMetadata"]>[2],
    _tx?: unknown
  ): Promise<{ count: number }> {
    // Route by run id, dropping the forwarded tx so the inner store writes to
    // its OWN prisma — this is what proves the CAS targets the owning store.
    return this.#resolveById(runId).updateMetadata(runId, data, options);
  }

  // ---- Everything else: delegate by run id to satisfy the RunStore interface;
  // not exercised by these tests. ----

  createRun(params: any, _tx?: unknown): any {
    return this.#resolveById(params.data.id).createRun(params);
  }
  createCancelledRun(params: any, _tx?: unknown): any {
    return this.#resolveById(params.data.id).createCancelledRun(params);
  }
  createFailedRun(params: any, _tx?: unknown): any {
    return this.#resolveById(params.data.id).createFailedRun(params);
  }
  startAttempt(runId: string, data: any, args: any, _tx?: unknown): any {
    return (this.#resolveById(runId).startAttempt as any)(runId, data, args);
  }
  completeAttemptSuccess(runId: string, data: any, args: any, _tx?: unknown): any {
    return (this.#resolveById(runId).completeAttemptSuccess as any)(runId, data, args);
  }
  recordRetryOutcome(runId: string, data: any, args: any, _tx?: unknown): any {
    return (this.#resolveById(runId).recordRetryOutcome as any)(runId, data, args);
  }
  requeueRun(runId: string, args: any, _tx?: unknown): any {
    return (this.#resolveById(runId).requeueRun as any)(runId, args);
  }
  recordBulkActionMembership(runId: string, bulkActionId: string, _tx?: unknown): any {
    return this.#resolveById(runId).recordBulkActionMembership(runId, bulkActionId);
  }
  cancelRun(runId: string, data: any, args: any, _tx?: unknown): any {
    return (this.#resolveById(runId).cancelRun as any)(runId, data, args);
  }
  failRunPermanently(runId: string, data: any, args: any, _tx?: unknown): any {
    return (this.#resolveById(runId).failRunPermanently as any)(runId, data, args);
  }
  expireRun(runId: string, data: any, args: any, _tx?: unknown): any {
    return (this.#resolveById(runId).expireRun as any)(runId, data, args);
  }
  expireRunsBatch(runIds: string[], data: any, _tx?: unknown): any {
    return this.#resolveById(runIds[0] ?? "").expireRunsBatch(runIds, data);
  }
  lockRunToWorker(runId: string, data: any, _tx?: unknown): any {
    return this.#resolveById(runId).lockRunToWorker(runId, data);
  }
  parkPendingVersion(runId: string, data: any, args: any, _tx?: unknown): any {
    return (this.#resolveById(runId).parkPendingVersion as any)(runId, data, args);
  }
  promotePendingVersionRuns(runId: string, _tx?: unknown): any {
    return this.#resolveById(runId).promotePendingVersionRuns(runId);
  }
  suspendForCheckpoint(runId: string, args: any, _tx?: unknown): any {
    return (this.#resolveById(runId).suspendForCheckpoint as any)(runId, args);
  }
  resumeFromCheckpoint(runId: string, args: any, _tx?: unknown): any {
    return (this.#resolveById(runId).resumeFromCheckpoint as any)(runId, args);
  }
  rescheduleRun(runId: string, data: any, _tx?: unknown): any {
    return this.#resolveById(runId).rescheduleRun(runId, data);
  }
  enqueueDelayedRun(runId: string, data: any, _tx?: unknown): any {
    return this.#resolveById(runId).enqueueDelayedRun(runId, data);
  }
  rewriteDebouncedRun(runId: string, data: any, _tx?: unknown): any {
    return this.#resolveById(runId).rewriteDebouncedRun(runId, data);
  }
  clearIdempotencyKey(params: any, _tx?: unknown): any {
    const runId = params?.byId?.runId ?? "";
    return this.#resolveById(runId).clearIdempotencyKey(params);
  }
  pushTags(runId: string, tags: string[], where: any, _tx?: unknown): any {
    return this.#resolveById(runId).pushTags(runId, tags, where);
  }
  pushRealtimeStream(runId: string, streamId: string, _tx?: unknown): any {
    return this.#resolveById(runId).pushRealtimeStream(runId, streamId);
  }
}

function buildRoutingStore(prisma17: PrismaClient, prisma14: PrismaClient) {
  const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
  const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
  return new RoutingRunStore(newStore, legacyStore);
}

// 25-char cuid-format id (starts with 'c'), length-disjoint from the 27-char KSUID.
function generateLegacyCuid() {
  const suffix = Array.from(
    { length: 24 },
    () => "0123456789abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 36)]
  ).join("");
  return `c${suffix}`;
}

async function seedOrgProjectEnv(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `test-${suffix}`, slug: `test-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `test-${suffix}`,
      slug: `test-${suffix}`,
      organizationId: organization.id,
      externalRef: `test-${suffix}`,
    },
  });
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `test-${suffix}`,
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `test-${suffix}`,
      pkApiKey: `test-${suffix}`,
      shortcode: `test-${suffix}`,
    },
  });
  return { organization, project, runtimeEnvironment };
}

describe("UpdateMetadataService store routing (hetero)", () => {
  heteroPostgresTest(
    "routes read+CAS to the owning (NEW/PG17) store for a KSUID run",
    async ({ prisma17, prisma14 }) => {
      const runId = generateKsuidId();
      expect(runId.length).toBe(27);

      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma17,
        "new"
      );

      const seeded = await prisma17.taskRun.create({
        data: {
          id: runId,
          friendlyId: `run_${runId}`,
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      const service = new UpdateMetadataService({
        // prisma is set to one of the clients only to satisfy the required option;
        // the routing store deliberately does NOT honor it for residency.
        prisma: prisma17,
        runStore: buildRoutingStore(prisma17, prisma14),
        flushIntervalMs: 100,
        flushEnabled: true,
        flushLoggingEnabled: true,
        maximumSize: 1024 * 1024 * 1,
        logLevel: "error",
      });

      const result = await service.call(runId, {
        operations: [{ type: "set", key: "foo", value: "bar" }],
      });

      expect(result?.metadata).toEqual({ foo: "bar" });

      // The owning store (PG17) has the update with version incremented by exactly 1.
      const newRow = await prisma17.taskRun.findFirst({ where: { id: runId } });
      expect(newRow).not.toBeNull();
      const newMetadata = await parsePacket({
        data: newRow?.metadata ?? undefined,
        dataType: newRow?.metadataType ?? "application/json",
      });
      expect(newMetadata).toEqual({ foo: "bar" });
      // CAS incremented the version by exactly 1.
      expect(newRow?.metadataVersion).toBe(seeded.metadataVersion + 1);

      // The LEGACY store (PG14) never saw this id — no cross-DB leakage.
      const legacyRow = await prisma14.taskRun.findFirst({ where: { id: runId } });
      expect(legacyRow).toBeNull();

      service.stopFlushing();
    }
  );

  heteroPostgresTest(
    "preserves CAS under concurrent writers on a NEW-DB (PG17) run",
    async ({ prisma17, prisma14 }) => {
      const runId = generateKsuidId();
      expect(runId.length).toBe(27);

      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma17,
        "cas"
      );

      const seeded = await prisma17.taskRun.create({
        data: {
          id: runId,
          friendlyId: `run_${runId}`,
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      let onAfterReadCallCount = 0;

      const service = new UpdateMetadataService({
        prisma: prisma17,
        runStore: buildRoutingStore(prisma17, prisma14),
        flushIntervalMs: 100,
        flushEnabled: true,
        flushLoggingEnabled: true,
        maximumSize: 1024 * 1024 * 1,
        logLevel: "error",
        onAfterRead: async (rId) => {
          onAfterReadCallCount++;
          // Simulate a concurrent writer landing between the service's read and CAS,
          // for the first 3 reads — forcing CAS count===0 and a retry each time.
          // The concurrent writes go straight to PG17 (the owning DB).
          if (onAfterReadCallCount <= 3) {
            await prisma17.taskRun.updateMany({
              where: { id: rId },
              data: {
                metadata: JSON.stringify({ concurrent: `update${onAfterReadCallCount}` }),
                metadataVersion: { increment: 1 },
              },
            });
          }
        },
      });

      const result = await service.call(runId, {
        operations: [{ type: "set", key: "immediate", value: "value1" }],
      });

      // Initial read + 3 retries.
      expect(onAfterReadCallCount).toBe(4);

      // No lost update: the final state reflects BOTH the last concurrent write and
      // the service's operation.
      expect(result?.metadata).toEqual({ concurrent: "update3", immediate: "value1" });

      // Let the buffered (post-retry) operation flush to the owning store.
      await setTimeout(1000);

      const newRow = await prisma17.taskRun.findFirst({ where: { id: runId } });
      const metadata = await parsePacket({
        data: newRow?.metadata ?? undefined,
        dataType: newRow?.metadataType ?? "application/json",
      });
      expect(metadata).toEqual({ concurrent: "update3", immediate: "value1" });

      // 3 concurrent increments + 1 successful service CAS, relative to the seed.
      expect(newRow?.metadataVersion).toBe(seeded.metadataVersion + 4);

      // LEGACY store untouched.
      const legacyRow = await prisma14.taskRun.findFirst({ where: { id: runId } });
      expect(legacyRow).toBeNull();

      service.stopFlushing();
    }
  );

  heteroPostgresTest(
    "routes read-through + CAS to the LEGACY (PG14) store for a cuid run without spanning DBs",
    async ({ prisma17, prisma14 }) => {
      const runId = generateLegacyCuid();
      expect(runId.length).toBe(25);

      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma14,
        "legacy"
      );

      const seeded = await prisma14.taskRun.create({
        data: {
          id: runId,
          friendlyId: `run_${runId}`,
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      const service = new UpdateMetadataService({
        prisma: prisma17,
        runStore: buildRoutingStore(prisma17, prisma14),
        flushIntervalMs: 100,
        flushEnabled: true,
        flushLoggingEnabled: true,
        maximumSize: 1024 * 1024 * 1,
        logLevel: "error",
      });

      // Call WITHOUT an environment arg, so the `where` is just `{ id: runId }` and
      // the router classifies by id length (25 => LEGACY).
      const result = await service.call(runId, {
        operations: [{ type: "set", key: "x", value: 1 }],
      });

      expect(result?.metadata).toEqual({ x: 1 });

      // The owning LEGACY store (PG14) got the update.
      const legacyRow = await prisma14.taskRun.findFirst({ where: { id: runId } });
      expect(legacyRow).not.toBeNull();
      const legacyMetadata = await parsePacket({
        data: legacyRow?.metadata ?? undefined,
        dataType: legacyRow?.metadataType ?? "application/json",
      });
      expect(legacyMetadata).toEqual({ x: 1 });
      // CAS incremented the version by exactly 1.
      expect(legacyRow?.metadataVersion).toBe(seeded.metadataVersion + 1);

      // The NEW store (PG17) never saw a write for this id — read-through resolved to
      // LEGACY and the CAS targeted the SAME store.
      const newRow = await prisma17.taskRun.findFirst({ where: { id: runId } });
      expect(newRow).toBeNull();

      service.stopFlushing();
    }
  );
});
