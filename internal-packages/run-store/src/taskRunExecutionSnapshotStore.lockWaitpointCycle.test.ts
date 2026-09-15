// F1: a redis-primary resume-lock must carry the PRECEDING completed-waitpoint cycle into the lock
// snapshot. Postgres holds no join rows for a redis-primary run, so if lockRunToWorker drops the cycle
// the resumed run reproduces no waitpoints and hangs. Real Postgres + Redis; no Postgres read on lock.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore, type CompletedWaitpointRecord } from "./redisSnapshotStore.js";
import {
  SnapshotWriteUnavailableError,
  TaskRunExecutionSnapshotStore,
} from "./taskRunExecutionSnapshotStore.js";
import { SnapshotResidencyResolver } from "./snapshotResidencyResolver.js";
import { snapshotKeys } from "./snapshotKeys.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
  seedSnapshotWorker,
} from "./testFixtures/snapshotIdFixture.js";

// The cycle key the append Lua derives from the entry key by stripping `:e` and appending `:wp:<n>`.
// Deleting it simulates the head cycle expiring/evicting out from under a still-live keyspace, which
// is the ONLY condition under which a carryForward lock re-mints the cycle from its carried refs.
function cycleKey(runId: string, cycleSeq: number): string {
  const base = snapshotKeys(runId).e.slice(0, -2);
  return `${base}:wp:${cycleSeq}`;
}

const ROUTE = "logical:1";

function birthSnapshot(env: Awaited<ReturnType<typeof seedSnapshotEnvironment>>, id: string) {
  return {
    id,
    createdAt: new Date(),
    engine: "V2" as const,
    executionStatus: "RUN_CREATED" as const,
    description: "created",
    runStatus: "PENDING" as const,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

describe("redis-primary lockRunToWorker carries the completed-waitpoint cycle (F1)", () => {
  containerTest(
    "a resume-lock preserves the head's completed waitpoints in MemoryDB",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const decorator = new TaskRunExecutionSnapshotStore(delegate, {
        store,
        mode: "redis-only",
        resolveDial: () => "redis-only",
        residencyResolver: new SnapshotResidencyResolver({
          store,
          taskRunExists: async (id: string) => (await prisma.taskRun.count({ where: { id } })) > 0,
        }),
        logicalRunStoreRoute: ROUTE,
      });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const { workerId, taskId } = await seedSnapshotWorker(prisma, env);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        await decorator.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        // A transition establishes the head cycle: indexed order [A,B,A] (A repeats at 0 AND 2), plus a
        // DISTINCT unindexed id C, with records for all three distinct ids.
        const rec = (id: string): CompletedWaitpointRecord => ({
          id,
          friendlyId: `waitpoint_${id}`,
          type: "RUN",
          completedAt: "2026-01-01T00:00:00.000Z",
          outputType: "application/json",
          outputIsError: false,
          output: { inline: id },
        });
        const records = [rec("A"), rec("B"), rec("C")];
        const transitionId = generateInternalId();
        await decorator.createExecutionSnapshot({
          id: transitionId,
          createdAt: new Date(),
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING_WITH_WAITPOINTS", description: "waited" },
          previousSnapshotId: birthId,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
          completedWaitpoints: [
            { id: "A", index: 0 },
            { id: "B", index: 1 },
            { id: "A", index: 2 },
            { id: "C" },
          ],
          resolveCompletedWaitpointRecords: async () => records,
        });

        // The resume-lock re-propagates the SAME refs the wire carries: order [A,B,A] and the distinct
        // id set {A,B,C}, with no records.
        const lockId = generateInternalId();
        await decorator.lockRunToWorker(runId, {
          lockedAt: new Date(),
          lockedById: taskId,
          lockedToVersionId: workerId,
          lockedQueueId: undefined as unknown as string,
          startedAt: new Date(),
          baseCostInCents: 0,
          machinePreset: "small-1x",
          taskVersion: "1.0",
          sdkVersion: null,
          cliVersion: null,
          maxDurationInSeconds: null,
          snapshot: {
            id: lockId,
            previousSnapshotId: transitionId,
            attemptNumber: 1,
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
            completedWaitpointIds: ["A", "B", "C"],
            completedWaitpointOrder: ["A", "B", "A"],
          },
        });

        // The lock snapshot is the new head and reproduces the cycle EXACTLY from MemoryDB alone:
        // the indexed order preserves the [A,B,A] duplicate, the distinct set is {A,B,C}, and every
        // distinct id's record reproduces.
        expect((await store.getLatest(runId))?.id).toBe(lockId);
        const read = await store.getSnapshotCompletedWaitpoints(runId, lockId);
        expect(read.present).toBe(true);
        expect(read.order).toEqual(["A", "B", "A"]);
        expect([...read.distinctIds].sort()).toEqual(["A", "B", "C"]);
        expect(read.records.map((r) => r.id).sort()).toEqual(["A", "B", "C"]);
      } finally {
        await store.quit();
      }
    }
  );

  // F1 reconstruction guard + Packet 1 completeness. A carryForward lock validates the head's COMPLETE
  // cycle at buildCycle time (inside the txn) and carries its refs AND records. If that head cycle then
  // disappears BETWEEN prepare and finalize, the append Lua re-mints from the carried payload — and the
  // re-mint must still be COMPLETE: exact [A,B,A] order (correct refs; the old `new Map(order)` collapses
  // A's two positions to [B,A]), the {A,B,C} distinct set, AND every record. The head-cycle eviction is
  // injected via the beforeFinalize seam (after prepare/commit, before Redis finalize).
  containerTest(
    "a head cycle that disappears between prepare and finalize is re-minted EXACTLY, records included",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions);
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      let armedEvictSeq = 0;
      let runIdForEvict = "";
      const decorator = new TaskRunExecutionSnapshotStore(delegate, {
        store,
        mode: "redis-only",
        resolveDial: () => "redis-only",
        residencyResolver: new SnapshotResidencyResolver({
          store,
          taskRunExists: async (id: string) => (await prisma.taskRun.count({ where: { id } })) > 0,
        }),
        logicalRunStoreRoute: ROUTE,
        // Drop the head cycle AFTER the lock's prepare/commit, BEFORE its finalize: buildCycle has already
        // validated the present cycle and carried its records, so finalize must re-mint from the payload.
        hooks: {
          beforeFinalize: async () => {
            if (armedEvictSeq > 0) await raw.del(cycleKey(runIdForEvict, armedEvictSeq));
          },
        },
      });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const { workerId, taskId } = await seedSnapshotWorker(prisma, env);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        await decorator.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        const rec = (id: string): CompletedWaitpointRecord => ({
          id,
          friendlyId: `waitpoint_${id}`,
          type: "RUN",
          completedAt: "2026-01-01T00:00:00.000Z",
          outputType: "application/json",
          outputIsError: false,
          output: { inline: id },
        });
        const transitionId = generateInternalId();
        await decorator.createExecutionSnapshot({
          id: transitionId,
          createdAt: new Date(),
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING_WITH_WAITPOINTS", description: "waited" },
          previousSnapshotId: birthId,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
          completedWaitpoints: [
            { id: "A", index: 0 },
            { id: "B", index: 1 },
            { id: "A", index: 2 },
            { id: "C" },
          ],
          resolveCompletedWaitpointRecords: async () => [rec("A"), rec("B"), rec("C")],
        });

        // Arm the beforeFinalize eviction of THIS head cycle: it is present now (buildCycle will validate
        // it and carry its records), and vanishes only after prepare/commit, before Redis finalize.
        const headCycleSeq = (await store.getLatest(runId))?.cycle?.cycleSeq;
        expect(headCycleSeq).toBeGreaterThan(0);
        runIdForEvict = runId;
        armedEvictSeq = headCycleSeq!;

        const lockId = generateInternalId();
        await decorator.lockRunToWorker(runId, {
          lockedAt: new Date(),
          lockedById: taskId,
          lockedToVersionId: workerId,
          lockedQueueId: undefined as unknown as string,
          startedAt: new Date(),
          baseCostInCents: 0,
          machinePreset: "small-1x",
          taskVersion: "1.0",
          sdkVersion: null,
          cliVersion: null,
          maxDurationInSeconds: null,
          snapshot: {
            id: lockId,
            previousSnapshotId: transitionId,
            attemptNumber: 1,
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
            completedWaitpointIds: ["A", "B", "C"],
            completedWaitpointOrder: ["A", "B", "A"],
          },
        });

        // The re-minted cycle is COMPLETE: the [A,B,A] duplicate survives (a `Map`-collapsed
        // reconstruction would yield [B,A]), the distinct set is {A,B,C}, AND every record reproduces —
        // proving the carried payload, not the vanished head cycle, mints a full cycle.
        expect((await store.getLatest(runId))?.id).toBe(lockId);
        const read = await store.getSnapshotCompletedWaitpoints(runId, lockId);
        expect(read.present).toBe(true);
        expect(read.danglingCycle).toBeFalsy();
        expect(read.order).toEqual(["A", "B", "A"]);
        expect([...read.distinctIds].sort()).toEqual(["A", "B", "C"]);
        expect(read.records.map((r) => r.id).sort()).toEqual(["A", "B", "C"]);
        expect(read.records.map((r) => (r.output as { inline: string }).inline).sort()).toEqual([
          "A",
          "B",
          "C",
        ]);
      } finally {
        await raw.quit();
        await store.quit();
      }
    }
  );

  // Never publish a partial cycle. If the head cycle is already gone when the lock's buildCycle runs
  // (so its records cannot be obtained and validated), the lock must THROW inside the owning Postgres
  // transaction — rolling it back — rather than advance the head with a cycle that has ids but no
  // records. The head stays at the prior transition and no lock snapshot is written.
  containerTest(
    "a lock whose head cycle is already gone at buildCycle throws and never advances the head",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions);
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const decorator = new TaskRunExecutionSnapshotStore(delegate, {
        store,
        mode: "redis-only",
        resolveDial: () => "redis-only",
        residencyResolver: new SnapshotResidencyResolver({
          store,
          taskRunExists: async (id: string) => (await prisma.taskRun.count({ where: { id } })) > 0,
        }),
        logicalRunStoreRoute: ROUTE,
      });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const { workerId, taskId } = await seedSnapshotWorker(prisma, env);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        await decorator.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        const rec = (id: string): CompletedWaitpointRecord => ({
          id,
          friendlyId: `waitpoint_${id}`,
          type: "RUN",
          completedAt: "2026-01-01T00:00:00.000Z",
          outputType: "application/json",
          outputIsError: false,
          output: { inline: id },
        });
        const transitionId = generateInternalId();
        await decorator.createExecutionSnapshot({
          id: transitionId,
          createdAt: new Date(),
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING_WITH_WAITPOINTS", description: "waited" },
          previousSnapshotId: birthId,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
          completedWaitpoints: [
            { id: "A", index: 0 },
            { id: "B", index: 1 },
          ],
          resolveCompletedWaitpointRecords: async () => [rec("A"), rec("B")],
        });

        // Head cycle gone BEFORE the lock's buildCycle runs: reproduction is impossible.
        const headCycleSeq = (await store.getLatest(runId))?.cycle?.cycleSeq;
        await raw.del(cycleKey(runId, headCycleSeq!));

        const lockId = generateInternalId();
        await expect(
          decorator.lockRunToWorker(runId, {
            lockedAt: new Date(),
            lockedById: taskId,
            lockedToVersionId: workerId,
            lockedQueueId: undefined as unknown as string,
            startedAt: new Date(),
            baseCostInCents: 0,
            machinePreset: "small-1x",
            taskVersion: "1.0",
            sdkVersion: null,
            cliVersion: null,
            maxDurationInSeconds: null,
            snapshot: {
              id: lockId,
              previousSnapshotId: transitionId,
              attemptNumber: 1,
              environmentId: env.id,
              environmentType: env.type,
              projectId: env.projectId,
              organizationId: env.organizationId,
              completedWaitpointIds: ["A", "B"],
              completedWaitpointOrder: ["A", "B"],
            },
          })
        ).rejects.toThrow(SnapshotWriteUnavailableError);

        // The head never advanced to the lock, and no lock snapshot exists.
        expect((await store.getLatest(runId))?.id).toBe(transitionId);
        expect(await store.getById(runId, lockId)).toBeNull();
      } finally {
        await raw.quit();
        await store.quit();
      }
    }
  );
});
