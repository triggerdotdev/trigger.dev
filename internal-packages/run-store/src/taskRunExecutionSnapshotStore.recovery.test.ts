// Vertical slice V2: prove the decorator<->recovery seam end-to-end. A real MIRRORED write that
// CRASHES after the Postgres commit but before finalize (the `beforeFinalize` seam) leaves the unit
// PREPARED + PENDING with Postgres committed; a subsequent write invokes the real PendingRecoveryWorker
// via real `pg_xact_status` on the SAME test Postgres, without a sweep. REAL Postgres + REAL Redis, no
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
import { pendingStreamKey, preparedUnitKey, runToPartition } from "./snapshotKeys.js";
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
      await store.quarantinePreparedUnit(unit, reason);
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
  containerTest.for([false, true])(
    "a dual-write transition recovers a committed orphan on busy (aged status: %s)",
    async (discardCommitStatus, { prisma, redisOptions }) => {
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

        // A normal dual-write read does not recover the pending transition.
        expect((await born.findLatestExecutionSnapshot(runId))?.id).toBe(transitionId);
        expect(await store.hasPreparedUnit(runId)).toBe(true);

        // The next write must recover the settled transaction on busy, then prepare once more.
        const quarantined: Array<{ unit: PreparedPgUnit; reason: QuarantineReason }> = [];
        const deps = recoveryDeps(store, index, prisma, quarantined);
        const checkPostgresCommit = deps.checkPostgresCommit;
        const worker = new PendingRecoveryWorker({
          ...deps,
          checkPostgresCommit: async (xid, route) => {
            const status = await checkPostgresCommit(xid, route);
            // Fault injection over a real committed transaction: simulate status retention expiring.
            if (discardCommitStatus) {
              expect(status).toBe("committed");
              return null;
            }
            return status;
          },
        });
        let recoveries = 0;
        const next = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          logicalRunStoreRoute: ROUTE,
          resolvePending: async (id, options) => {
            recoveries++;
            await worker.resolveEntry({ id: "", fields: { runId: id } }, options);
          },
        });
        const nextId = generateInternalId();
        const advance = (id: string, previousSnapshotId: string) =>
          next.createExecutionSnapshot({
            id,
            run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
            snapshot: { executionStatus: "EXECUTING", description: "Next transition" },
            previousSnapshotId,
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          });
        if (discardCommitStatus) {
          // Missing commit evidence must not abort an aged unit. Keep the real committed row, but
          // temporarily point the prepared unit at an absent probe, then restore its actual probe.
          const prepared = (await store.readPreparedUnitRaw(runId))!;
          const withoutProof = JSON.stringify({
            ...JSON.parse(prepared),
            commitProbeSnapshotId: generateInternalId(),
          });
          await raw.hset(preparedUnitKey(runId), "unit", withoutProof);
          await expect(advance(nextId, transitionId)).rejects.toThrow(
            "snapshot prepare rejected: busy"
          );
          expect(await store.readPreparedUnitRaw(runId)).toBe(withoutProof);
          expect((await store.getLatest(runId))?.id).toBe(birthId);
          await raw.hset(preparedUnitKey(runId), "unit", prepared);
        }
        await advance(nextId, transitionId);
        expect(recoveries).toBe(discardCommitStatus ? 2 : 1);
        expect(quarantined).toHaveLength(0);
        // Prepared unit cleared, pending-index entry XACKed, and the recovered transition published.
        expect(await store.hasPreparedUnit(runId)).toBe(false);
        expect(await pendingCount(raw, partition)).toBe(0);
        expect((await store.getLatest(runId))?.id).toBe(nextId);
        expect((await store.getById(runId, transitionId))?.id).toBe(transitionId);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(3);
        // Ordinary writes add no recovery call once the conflict has cleared.
        await advance(generateInternalId(), nextId);
        expect(recoveries).toBe(discardCommitStatus ? 2 : 1);
      } finally {
        await raw.quit();
        await indexRaw.quit();
        await store.quit();
      }
    }
  );

  containerTest(
    "busy writes leave live or unprovable units untouched, then recover after a confirmed rollback",
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

        let reportXid!: (xid: string) => void;
        const xidReady = new Promise<string>((resolve) => (reportXid = resolve));
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const transaction = prisma.$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<
              Array<{ xid: string }>
            >`SELECT pg_current_xact_id()::text AS xid`;
            reportXid(rows[0].xid);
            await held;
            throw new Error("deliberate rollback");
          },
          { timeout: 30_000 }
        );
        const rolledBack = expect(transaction).rejects.toThrow("deliberate rollback");
        try {
          const xid = await xidReady;
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

          const quarantined: Array<{ unit: PreparedPgUnit; reason: QuarantineReason }> = [];
          const worker = new PendingRecoveryWorker(recoveryDeps(store, index, prisma, quarantined));
          let recoveries = 0;
          const next = new TaskRunExecutionSnapshotStore(delegate, {
            store,
            mode: "dual-write",
            logicalRunStoreRoute: ROUTE,
            resolvePending: async (id, options) => {
              recoveries++;
              await worker.resolveEntry({ id: "", fields: { runId: id } }, options);
            },
          });
          const nextId = generateInternalId();
          const advance = () =>
            next.createExecutionSnapshot({
              id: nextId,
              run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
              snapshot: { executionStatus: "EXECUTING", description: "Next transition" },
              previousSnapshotId: birthId,
              environmentId: env.id,
              environmentType: env.type,
              projectId: env.projectId,
              organizationId: env.organizationId,
            });

          // Real transaction still active; future xid errors in real pg_xact_status; malformed data
          // has no provable owner. None permits deletion, publication, or quarantine, even on retry.
          for (const raw of [
            JSON.stringify(unit),
            JSON.stringify({ ...unit, postgresXid: String(BigInt(xid) + 1_000_000n) }),
            "invalid json",
            JSON.stringify({ ...unit, postgresXid: null }),
          ]) {
            await indexRaw.hset(preparedUnitKey(runId), "unit", raw);
            await expect(advance()).rejects.toThrow("snapshot prepare rejected: busy");
            expect(await store.readPreparedUnitRaw(runId)).toBe(raw);
            expect(await store.readPendingState(runId)).toEqual({
              prepared: true,
              quarantined: false,
            });
            expect((await store.getLatest(runId))?.id).toBe(birthId);
            expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(1);
          }
          expect(recoveries).toBe(4);
          await indexRaw.hset(preparedUnitKey(runId), "unit", JSON.stringify(unit));
          release();
          await rolledBack;
          await advance();
          expect(recoveries).toBe(5);
          expect(quarantined).toHaveLength(0);
          // Only the replacement transition publishes; the aborted transaction's entry never does.
          expect(await store.hasPreparedUnit(runId)).toBe(false);
          expect(await store.getById(runId, transitionId)).toBeNull();
          expect((await store.getLatest(runId))?.id).toBe(nextId);
          expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(2);
        } finally {
          release();
          await rolledBack;
        }
      } finally {
        await indexRaw.quit();
        await store.quit();
      }
    }
  );
});
