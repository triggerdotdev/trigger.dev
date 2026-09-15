// Milestone M8: at the redis-only dial a run is born REDIS-PRIMARY. Postgres holds NO TRES row and
// NO snapshot-to-waitpoint join rows; the snapshot (and its completed-waitpoint cycle) lives ONLY in
// MemoryDB; reads reproduce the full payload from the Redis entry with NO Postgres fallback. Proven
// end-to-end against REAL Postgres + REAL Redis (testcontainers, no mocks).
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import type { PrismaClient } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import {
  RedisSnapshotStore,
  type CompletedWaitpointResolver,
  type PreparedPgUnit,
} from "./redisSnapshotStore.js";
import {
  TaskRunExecutionSnapshotStore,
  SnapshotReadUnavailableError,
} from "./taskRunExecutionSnapshotStore.js";
import { PendingIndex } from "./pendingIndex.js";
import {
  PendingRecoveryWorker,
  type PostgresCommitStatus,
  type QuarantineReason,
  type RecoveryDeps,
} from "./pendingRecoveryWorker.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";

const ROUTE = "logical:1";

// A resolver that turns each stored record into ONE unenhanced read row, the same material a
// Postgres read returns. This is the seam the run-engine owns in production; here it reads only what
// the store hands it, never Redis. Index expansion and the nested completion objects are the
// run-engine enhancement step's job, so this deliberately produces neither.
const resolver: CompletedWaitpointResolver = async ({ records }) =>
  records.map((r) => ({
    id: r.id,
    friendlyId: r.friendlyId,
    type: r.type,
    completedAt: new Date(r.completedAt),
    completedByTaskRunId: r.completedByTaskRunId ?? null,
    completedByBatchId: r.completedByBatchId ?? null,
    completedAfter: r.completedAfter ? new Date(r.completedAfter) : null,
    outputType: r.outputType,
    outputIsError: r.outputIsError,
    output: r.output && "inline" in r.output ? r.output.inline : null,
    idempotencyKey: r.idempotencyKey ?? "",
    userProvidedIdempotencyKey: r.idempotencyKey !== undefined,
    inactiveIdempotencyKey: null,
  }));

function realCheck(prisma: PrismaClient) {
  return async (xid8: string): Promise<PostgresCommitStatus> => {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT pg_xact_status($1::xid8) AS status`,
      xid8
    )) as Array<{ status: string | null }>;
    return rows[0].status as PostgresCommitStatus;
  };
}

function recoveryDeps(
  store: RedisSnapshotStore,
  index: PendingIndex,
  prisma: PrismaClient
): RecoveryDeps {
  const quarantined: Array<{ unit: PreparedPgUnit; reason: QuarantineReason }> = [];
  return {
    store,
    pendingIndex: index,
    checkPostgresCommit: realCheck(prisma),
    // A redis-primary unit never has a commit-probe row, so this must never be reached in these tests.
    commitProbeExists: async () => false,
    quarantine: async (unit, reason) => {
      quarantined.push({ unit, reason });
    },
  };
}

function makeResolvePending(store: RedisSnapshotStore, worker: PendingRecoveryWorker) {
  return async (runId: string): Promise<void> => {
    const raw = await store.readPreparedUnitRaw(runId);
    if (raw === undefined) return;
    const unit = JSON.parse(raw) as PreparedPgUnit;
    await worker.resolveEntry({
      id: "0-0",
      fields: { runId, transitionToken: unit.transitionToken },
    });
  };
}

function birthSnapshot(env: Awaited<ReturnType<typeof seedSnapshotEnvironment>>, id: string) {
  return {
    id,
    createdAt: new Date(),
    engine: "V2" as const,
    executionStatus: "RUN_CREATED" as const,
    description: "Run was created",
    runStatus: "PENDING" as const,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

async function joinRowCount(prisma: PrismaClient, snapshotId: string): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "_completedWaitpoints" WHERE "A" = $1`,
    snapshotId
  )) as Array<{ n: number }>;
  return rows[0].n;
}

describe("TaskRunExecutionSnapshotStore (redis-only) redis-primary", () => {
  containerTest(
    "a birth and a transition write NO TRES row and NO join rows, but MemoryDB holds the head",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();

        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });

        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await writer.createExecutionSnapshot({
          id: transitionId,
          createdAt: new Date(),
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING", description: "Run started" },
          previousSnapshotId: birthId,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });

        // The TaskRun landed, but Postgres holds NO snapshot rows at all.
        expect(await prisma.taskRun.count({ where: { id: runId } })).toBe(1);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
        expect(await joinRowCount(prisma, transitionId)).toBe(0);

        // MemoryDB holds the finalized head.
        expect((await store.getLatest(runId))?.id).toBe(transitionId);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "the prepared unit is redis-primary with no commit-probe",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();

        // Capture the prepared unit at the crash point (after prepare, before finalize).
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          hooks: {
            beforeFinalize: () => {
              throw new Error("__hold__");
            },
          },
        });
        await expect(
          writer.createRun({
            data: buildCreateRunData(runId, env),
            snapshot: birthSnapshot(env, birthId),
          })
        ).rejects.toThrow(/__hold__/);

        const raw = await store.readPreparedUnitRaw(runId);
        expect(raw).toBeDefined();
        const unit = JSON.parse(raw!) as PreparedPgUnit;
        expect(unit.residency).toBe("redis-primary");
        expect(unit.commitProbeSnapshotId).toBeUndefined();
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a read reproduces the full payload from Redis, completed waitpoints included, with NO TRES row",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();
        const waitpointId = generateInternalId();

        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await writer.createExecutionSnapshot({
          id: transitionId,
          createdAt: new Date(),
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING", description: "Waitpoint completed" },
          previousSnapshotId: birthId,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
          completedWaitpoints: [{ id: waitpointId, index: 0 }],
          resolveCompletedWaitpointRecords: async () => [
            {
              id: waitpointId,
              friendlyId: "waitpoint_ok",
              type: "MANUAL",
              completedAt: "2026-01-01T00:00:00.000Z",
              outputType: "application/json",
              outputIsError: false,
              output: { inline: "42" },
            },
          ],
        });

        // No Postgres snapshot row exists.
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          resolveCompletedWaitpoints: resolver,
        });
        const head = await reader.findLatestExecutionSnapshot(runId);
        expect(head?.id).toBe(transitionId);
        expect(head?.executionStatus).toBe("EXECUTING");
        expect(head?.previousSnapshotId).toBe(birthId);
        expect(head?.completedWaitpointOrder).toEqual([waitpointId]);

        // The completed waitpoint was reproduced from the cycle records via the resolver. The store
        // returns unenhanced read rows, so no cast is needed and no `index` exists here: the order
        // travels separately on completedWaitpointOrder (asserted above) for the engine to apply.
        const completed = head?.completedWaitpoints;
        expect(completed).toHaveLength(1);
        expect(completed![0].id).toBe(waitpointId);
        expect(completed![0].output).toBe("42");
        expect(completed![0]).not.toHaveProperty("index");
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a checkpointId hydrates the checkpoint from Postgres by id",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();

        const checkpoint = await prisma.taskRunCheckpoint.create({
          data: {
            friendlyId: `checkpoint_${generateInternalId().slice(-12)}`,
            type: "DOCKER",
            location: "s3://bucket/checkpoint",
            projectId: env.projectId,
            runtimeEnvironmentId: env.id,
          },
        });

        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await writer.createExecutionSnapshot({
          id: transitionId,
          createdAt: new Date(),
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING", description: "Resumed from checkpoint" },
          previousSnapshotId: birthId,
          checkpointId: checkpoint.id,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });

        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          resolveCompletedWaitpoints: resolver,
        });
        const head = await reader.findLatestExecutionSnapshot(runId);
        expect(head?.checkpointId).toBe(checkpoint.id);
        expect(head?.checkpoint?.id).toBe(checkpoint.id);
        expect(head?.checkpoint?.location).toBe("s3://bucket/checkpoint");
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "an expired redis-primary run (state gone, marker present) fails closed, never a Postgres fallback",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();

        // Born redis-primary, then its snapshot state is dropped (as a 14-day TTL would): the no-TTL
        // residency marker survives, so residency resolves to `expired`, never a Postgres-resident miss.
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await store.dropRun(runId);
        expect(await store.getLatest(runId)).toBeNull();
        expect(await store.readBirthResidency(runId)).toBe("redis-primary");

        // A Postgres row planted for the same run: a wrongful fallback would return it. It must not.
        await prisma.taskRunExecutionSnapshot.create({
          data: {
            id: generateInternalId(),
            runId,
            engine: "V2",
            executionStatus: "EXECUTING",
            description: "planted",
            runStatus: "EXECUTING",
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          },
        });

        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          resolveCompletedWaitpoints: resolver,
        });
        await expect(reader.findLatestExecutionSnapshot(runId)).rejects.toBeInstanceOf(
          SnapshotReadUnavailableError
        );
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "a pending unit is resolved before returning the head",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const indexRaw = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(indexRaw);

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();

        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        // A transition that crashes after the Postgres commit but before finalize.
        const crashed = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          hooks: {
            beforeFinalize: () => {
              throw new Error("__crash_before_finalize__");
            },
          },
        });
        await expect(
          crashed.createExecutionSnapshot({
            id: transitionId,
            createdAt: new Date(),
            run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
            snapshot: { executionStatus: "EXECUTING", description: "Run started" },
            previousSnapshotId: birthId,
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          })
        ).rejects.toThrow(/__crash_before_finalize__/);
        expect(await store.hasPreparedUnit(runId)).toBe(true);

        const worker = new PendingRecoveryWorker(recoveryDeps(store, index, prisma));
        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          resolveCompletedWaitpoints: resolver,
          resolvePending: makeResolvePending(store, worker),
        });

        const head = await reader.findLatestExecutionSnapshot(runId);
        // pg_xact_status said committed => the pending unit finalized => the head advanced.
        expect(head?.id).toBe(transitionId);
        expect(await store.hasPreparedUnit(runId)).toBe(false);
      } finally {
        await indexRaw.quit();
        await store.quit();
      }
    }
  );
});
