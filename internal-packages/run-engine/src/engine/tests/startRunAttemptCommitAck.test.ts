// A run start's owning transaction can COMMIT in Postgres while its client never sees the
// acknowledgement (a commit reply that arrives after the interactive transaction's timeout). The
// attempt bump and the EXECUTING snapshot are durable, the recovery worker finalizes the prepared
// snapshot unit, and the caller's retry with the pre-start snapshot is correctly rejected as stale.
// The start must therefore recover its committed result itself instead of failing: a start that
// fails here strands the run EXECUTING with no task body until the stall handler cancels it.
// These drive the real `startRunAttempt` on real Postgres + Redis; only the delegate's transaction
// boundary is faulted, after the real transaction has committed (or rolled back).
import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import {
  PendingIndex,
  PendingRecoveryWorker,
  PostgresRunStore,
  RedisSnapshotStore,
  runToPartition,
  SnapshotResidencyResolver,
  TaskRunExecutionSnapshotStore,
  type PostgresCommitStatus,
  type RunStore,
} from "@internal/run-store";
import { createRedisClient } from "@internal/redis";
import { type PrismaClient, type PrismaClientOrTransaction } from "@trigger.dev/database";
import { RunEngine } from "../index.js";
import { createCompletedWaitpointResolver } from "../systems/completedWaitpointResolver.js";
import { PostgresPendingVersionRunIdLookup } from "./postgresPendingVersionLookup.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const ROUTE = "logical:1";
const machines = {
  defaultMachine: "small-1x",
  machines: {
    "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
  },
  baseCostInCents: 0.0001,
};
// Prisma's error for an interactive transaction whose commit reply arrived after its timeout.
const LOST_COMMIT_ACK =
  "Transaction already closed: A commit cannot be executed on an expired transaction. A commit cannot be executed on an expired transaction.";

type Fault = "commit-ack-lost" | "commit-rolled-back";

// A Postgres store whose NEXT owning transaction is faulted at the commit boundary, after the
// callback has returned. `commit-ack-lost`: the real transaction commits, then the client reports a
// failure (the lost acknowledgement). `commit-rolled-back`: the client reports the same failure but the
// transaction was rolled back (a commit that genuinely did not happen).
class CommitBoundaryFaultStore extends PostgresRunStore {
  armed: Fault | undefined;
  faults = 0;

  override async runInTransaction<R>(
    runId: string | undefined,
    fn: (store: RunStore, tx: PrismaClientOrTransaction) => Promise<R>
  ): Promise<R> {
    const fault = this.armed;
    if (!fault) return super.runInTransaction(runId, fn);
    this.armed = undefined;
    this.faults += 1;
    if (fault === "commit-rolled-back") {
      return super.runInTransaction(runId, async (store, tx) => {
        await fn(store, tx);
        throw new Error(LOST_COMMIT_ACK);
      });
    }
    await super.runInTransaction(runId, fn);
    throw new Error(LOST_COMMIT_ACK);
  }
}

// The recovery resolver wired as the webapp wires it: pg_xact_status and the commit probe on the
// writer, and the resolver's outcome discarded.
function recoveryResolver(
  prisma: PrismaClient,
  redisOptions: any,
  snapshotStore: RedisSnapshotStore
) {
  const indexRaw = createRedisClient(redisOptions, { onError: () => {} });
  const index = new PendingIndex(indexRaw);
  const recovery = new PendingRecoveryWorker({
    store: snapshotStore,
    pendingIndex: index,
    checkPostgresCommit: async (xid) => {
      const rows = await prisma.$queryRawUnsafe<Array<{ status: PostgresCommitStatus }>>(
        "SELECT pg_xact_status($1::xid8) AS status",
        xid
      );
      return rows[0]?.status ?? null;
    },
    commitProbeExists: async (snapshotId) => {
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        'SELECT 1 FROM "TaskRunExecutionSnapshot" WHERE id = $1',
        snapshotId
      );
      return rows.length > 0;
    },
    quarantine: async (unit, reason) => {
      await snapshotStore.quarantinePreparedUnit(unit, reason);
    },
  });
  return {
    index,
    resolvePending: async (id: string, options?: { requireSettledTransaction?: boolean }) => {
      await recovery.resolveEntry({ id: "", fields: { runId: id } }, options);
    },
    quit: () => indexRaw.quit(),
  };
}

async function dequeuedRun(
  prisma: PrismaClient,
  redisOptions: any,
  friendlyId: string,
  dial: "dual-write" | "redis-only"
) {
  const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
  const recovery = recoveryResolver(prisma, redisOptions, snapshotStore);
  const delegate = new CommitBoundaryFaultStore({ prisma, readOnlyPrisma: prisma });
  const store = new TaskRunExecutionSnapshotStore(delegate, {
    store: snapshotStore,
    mode: "dual-write",
    resolveDial: () => dial,
    residencyResolver: new SnapshotResidencyResolver({ store: snapshotStore }),
    resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
    resolvePrimaryReadClient: () => delegate.primaryReadClient,
    resolvePending: recovery.resolvePending,
    logicalRunStoreRoute: ROUTE,
  });
  const engine = new RunEngine({
    prisma,
    store,
    worker: { redis: redisOptions, disabled: true },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines,
    pendingVersionRunIdLookup: new PostgresPendingVersionRunIdLookup(prisma),
    tracer: trace.getTracer("test", "0.0.0"),
  });
  const cleanup = async () => {
    await engine.quit();
    await recovery.quit();
    await snapshotStore.quit();
  };
  try {
    await setupBackgroundWorker(engine, env, "test-task");
    const run = await engine.trigger(
      {
        number: 1,
        friendlyId,
        environment: env,
        taskIdentifier: "test-task",
        payload: "{}",
        payloadType: "application/json",
        context: {},
        traceContext: {},
        traceId: `t-${friendlyId}`,
        spanId: `s-${friendlyId}`,
        workerQueue: "main",
        queue: "task/test-task",
        isTest: false,
        tags: [],
      },
      prisma
    );
    await recovery.index.ensureGroup(runToPartition(run.id));
    let dequeued: Awaited<ReturnType<RunEngine["dequeueFromWorkerQueue"]>> = [];
    for (let i = 0; i < 25 && dequeued.length === 0; i++) {
      await engine.runQueue.processMasterQueueForEnvironment(env.id, 5);
      dequeued = await engine.dequeueFromWorkerQueue({
        consumerId: friendlyId,
        workerQueue: "main",
      });
      if (dequeued.length === 0) await setTimeout(200);
    }
    expect(dequeued.length).toBe(1);
    const dequeuedSnapshotId = dequeued[0].snapshot.id;
    // Precondition: the run is a MemoryDB resident, so its start goes through the prepare protocol.
    expect((await snapshotStore.getLatest(run.id))?.id).toBe(dequeuedSnapshotId);
    return { env, run, dequeuedSnapshotId, engine, delegate, snapshotStore, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

describe("startRunAttempt whose transaction committed but lost its acknowledgement", () => {
  containerTest.for(["dual-write", "redis-only"] as const)(
    "returns the committed start so the task body can run (%s)",
    async (dial, { prisma, redisOptions }) => {
      const t = await dequeuedRun(
        prisma,
        redisOptions,
        `run_ack${dial === "dual-write" ? "dw" : "ro"}`,
        dial
      );
      try {
        t.delegate.armed = "commit-ack-lost";
        const started = await t.engine.startRunAttempt({
          runId: t.run.id,
          snapshotId: t.dequeuedSnapshotId,
        });
        expect(t.delegate.faults).toBe(1);
        expect(started.run.attemptNumber).toBe(1);
        expect(started.snapshot.executionStatus).toBe("EXECUTING");

        // The returned snapshot is the durable head everywhere, with nothing left pending.
        const head = await t.engine.getRunExecutionData({ runId: t.run.id });
        expect(head?.snapshot.id).toBe(started.snapshot.id);
        expect((await t.snapshotStore.getLatest(t.run.id))?.id).toBe(started.snapshot.id);
        expect(await t.snapshotStore.hasPreparedUnit(t.run.id)).toBe(false);
        const stored = await prisma.taskRun.findUniqueOrThrow({
          where: { id: t.run.id },
          select: { status: true, attemptNumber: true },
        });
        expect(stored).toEqual({ status: "EXECUTING", attemptNumber: 1 });

        // The pre-start snapshot is stale for anyone else: no second claim of the same execution.
        await expect(
          t.engine.startRunAttempt({ runId: t.run.id, snapshotId: t.dequeuedSnapshotId })
        ).rejects.toThrow("Snapshot changed inside startRunAttempt");

        // The task proceeds on the recovered start.
        const completed = await t.engine.completeRunAttempt({
          runId: t.run.id,
          snapshotId: started.snapshot.id,
          completion: { id: t.run.id, ok: true, output: '"ok"', outputType: "application/json" },
        });
        expect(completed.attemptStatus).toBe("RUN_FINISHED");
        expect((await prisma.taskRun.findUniqueOrThrow({ where: { id: t.run.id } })).status).toBe(
          "COMPLETED_SUCCESSFULLY"
        );
      } finally {
        await t.cleanup();
      }
    }
  );

  containerTest(
    "a start whose transaction rolled back still fails, and the same snapshot retries once",
    async ({ prisma, redisOptions }) => {
      const t = await dequeuedRun(prisma, redisOptions, "run_ackrb", "dual-write");
      try {
        t.delegate.armed = "commit-rolled-back";
        await expect(
          t.engine.startRunAttempt({ runId: t.run.id, snapshotId: t.dequeuedSnapshotId })
        ).rejects.toThrow("Failed to update task run and execution snapshot");
        expect(t.delegate.faults).toBe(1);

        // Nothing durable advanced: no attempt bump, head unchanged, no pending unit left behind.
        const stored = await prisma.taskRun.findUniqueOrThrow({
          where: { id: t.run.id },
          select: { status: true, attemptNumber: true },
        });
        expect(stored.attemptNumber).toBeNull();
        expect((await t.snapshotStore.getLatest(t.run.id))?.id).toBe(t.dequeuedSnapshotId);
        expect(await t.snapshotStore.hasPreparedUnit(t.run.id)).toBe(false);

        // The caller's retry with the same snapshot starts attempt 1 exactly once.
        const started = await t.engine.startRunAttempt({
          runId: t.run.id,
          snapshotId: t.dequeuedSnapshotId,
        });
        expect(started.run.attemptNumber).toBe(1);
        expect(
          (await prisma.taskRun.findUniqueOrThrow({ where: { id: t.run.id } })).attemptNumber
        ).toBe(1);
      } finally {
        await t.cleanup();
      }
    }
  );
});
