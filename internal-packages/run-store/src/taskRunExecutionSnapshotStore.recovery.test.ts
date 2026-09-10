// Vertical slice V2: prove the decorator<->recovery seam end-to-end. A real MIRRORED write that
// CRASHES after the Postgres commit but before finalize (the `beforeFinalize` seam) leaves the unit
// PREPARED + PENDING with Postgres committed; the real PendingRecoveryWorker then resolves it via the
// real `pg_xact_status` on the SAME test Postgres. REAL Postgres + REAL Redis (testcontainers), no
// mocks: checkPostgresCommit / commitProbeExists run raw SQL on the test primary.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import type { PrismaClient } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import {
  RedisSnapshotStore,
  type PreparedPgUnit,
  type SnapshotEntryInput,
} from "./redisSnapshotStore.js";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import { PendingIndex, RECOVERY_CONSUMER_GROUP } from "./pendingIndex.js";
import {
  PendingRecoveryWorker,
  type PostgresCommitStatus,
  type QuarantineReason,
  type RecoveryDeps,
} from "./pendingRecoveryWorker.js";
import { pendingStreamKey, runToPartition } from "./snapshotKeys.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";

const ROUTE = "logical:1";

// checkPostgresCommit wired to REAL SQL on the (single test) Postgres primary — the same wiring the
// M4 worker test uses.
function realCheck(prisma: PrismaClient) {
  return async (xid8: string): Promise<PostgresCommitStatus> => {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT pg_xact_status($1::xid8) AS status`,
      xid8
    )) as Array<{ status: string | null }>;
    return rows[0].status as PostgresCommitStatus;
  };
}

// commitProbeExists wired to a REAL point-read of the mirrored commit probe: the TRES row the
// mirrored decorator names as `commitProbeSnapshotId`. Present => the owning tx committed.
function realProbe(prisma: PrismaClient) {
  return async (snapshotId: string): Promise<boolean> => {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT 1 FROM "TaskRunExecutionSnapshot" WHERE id = $1`,
      snapshotId
    )) as unknown[];
    return rows.length > 0;
  };
}

// A real aborted xid: assign an xid inside a tx, then roll back by throwing out of it.
async function abortedXid(prisma: PrismaClient): Promise<string> {
  let xid = "";
  try {
    await prisma.$transaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(`SELECT pg_current_xact_id()::text AS xid`)) as Array<{
        xid: string;
      }>;
      xid = rows[0].xid;
      throw new Error("__rollback__");
    });
  } catch (e) {
    if (!(e instanceof Error && e.message === "__rollback__")) throw e;
  }
  return xid;
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

function recoveryDeps(
  store: RedisSnapshotStore,
  index: PendingIndex,
  prisma: PrismaClient,
  quarantined: Array<{ unit: PreparedPgUnit; reason: QuarantineReason }>
): RecoveryDeps {
  return {
    store,
    pendingIndex: index,
    checkPostgresCommit: realCheck(prisma),
    commitProbeExists: realProbe(prisma),
    quarantine: async (unit, reason) => {
      quarantined.push({ unit, reason });
    },
  };
}

async function pendingCount(raw: ReturnType<typeof createRedisClient>, partition: number) {
  const pending = (await raw.xpending(
    pendingStreamKey(partition),
    RECOVERY_CONSUMER_GROUP
  )) as unknown[];
  return pending[0];
}

describe("TaskRunExecutionSnapshotStore (crash after commit, before finalize) -> recovery", () => {
  containerTest(
    "beforeFinalize crash leaves the unit PENDING with Postgres committed; recovery finalizes via pg_xact_status",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      const indexRaw = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(indexRaw);

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();
        const partition = runToPartition(runId);

        // Recovery groups exist before any write, exactly as a worker's ensureAllGroups() at startup.
        await index.ensureGroup(partition);

        // A committed birth via a plain (no-fault) decorator.
        const born = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
        });
        await born.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        expect((await store.getLatest(runId))?.id).toBe(birthId);

        // A decorator that CRASHES after the commit, before finalize.
        const crashed = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
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

        // Interrupted state: the unit is PENDING, Postgres committed BOTH TRES rows, and the crashed
        // transition is hidden until finalize (head still the birth).
        expect(await store.hasPreparedUnit(runId)).toBe(true);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(2);
        expect((await store.getLatest(runId))?.id).toBe(birthId);

        // Recovery: the worker reads pg_xact_status(xid) on the SAME primary => committed => finalize.
        const quarantined: Array<{ unit: PreparedPgUnit; reason: QuarantineReason }> = [];
        const worker = new PendingRecoveryWorker(recoveryDeps(store, index, prisma, quarantined));
        const outcomes = await worker.processPartition(partition, "w1");

        expect(outcomes).toEqual([{ kind: "finalized", runId }]);
        expect(quarantined).toHaveLength(0);
        // Prepared unit cleared, pending-index entry XACKed, and the recovered transition published.
        expect(await store.hasPreparedUnit(runId)).toBe(false);
        expect(await pendingCount(raw, partition)).toBe(0);
        expect((await store.getLatest(runId))?.id).toBe(transitionId);
      } finally {
        await raw.quit();
        await indexRaw.quit();
        await store.quit();
      }
    }
  );

  containerTest(
    "a pending unit whose owning tx rolled back is ABORTED by recovery (no phantom published head)",
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
        const partition = runToPartition(runId);

        await index.ensureGroup(partition);

        // A committed birth via a plain decorator: the real published head.
        const born = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
        });
        await born.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        expect((await store.getLatest(runId))?.id).toBe(birthId);

        // The decorator's inline abort makes a rolled-back tx unreachable as a PENDING unit through
        // the seam, so (as the plan allows) seed the pending unit for a REAL rolled-back xid directly,
        // exactly as the M4 test does. commitProbeSnapshotId is absent in Postgres, but pg_xact_status
        // returns `aborted` outright, so recovery never needs the probe.
        const xid = await abortedXid(prisma);
        const stagedEntry: SnapshotEntryInput = {
          id: transitionId,
          runId,
          engine: "V2",
          executionStatus: "EXECUTING",
          description: "Run started",
          runStatus: "EXECUTING",
          createdAt: new Date().toISOString(),
          previousSnapshotId: birthId,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        };
        const unit: PreparedPgUnit = {
          protocolVersion: 1,
          transitionToken: generateInternalId(),
          postgresXid: xid,
          runId,
          organizationId: env.organizationId,
          residency: "mirrored",
          logicalRunStoreRoute: ROUTE,
          entries: [
            { entry: stagedEntry, kind: "transition", isTerminal: false, expectedCur: birthId },
          ],
          commitProbeSnapshotId: transitionId,
        };
        expect((await store.prepare(unit)).outcome).toBe("prepared");
        expect(await store.hasPreparedUnit(runId)).toBe(true);

        // Recovery: pg_xact_status(xid) => aborted => abortPrepared.
        const quarantined: Array<{ unit: PreparedPgUnit; reason: QuarantineReason }> = [];
        const worker = new PendingRecoveryWorker(recoveryDeps(store, index, prisma, quarantined));
        const outcomes = await worker.processPartition(partition, "w1");

        expect(outcomes).toEqual([{ kind: "aborted", runId }]);
        expect(quarantined).toHaveLength(0);
        // Pending cleared, staged entry never published: the head is still the committed birth.
        expect(await store.hasPreparedUnit(runId)).toBe(false);
        expect(await store.getById(runId, transitionId)).toBeNull();
        expect((await store.getLatest(runId))?.id).toBe(birthId);
      } finally {
        await indexRaw.quit();
        await store.quit();
      }
    }
  );
});
