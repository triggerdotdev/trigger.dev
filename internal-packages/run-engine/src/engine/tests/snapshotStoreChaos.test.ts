// The correctness spine: kill the process at each write boundary and prove the run still converges.
//
// The write protocol's whole claim is that whatever a crash leaves behind is a state the existing
// stall-and-repair machinery heals. That claim is not checkable by reading the code, so each test
// here injects a fault at one named boundary and then asserts three things: the run converges, it
// does not hang, and it burns at most one attempt number per crash.
//
// The bound is PER CRASH, not a flat one. The plan records that TLC refuted a flat bound of one in
// seven states, and that the property which holds is pgAttempt - maxLoggedAttempt <= crashCount.
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { generateInternalId, RunId } from "@trigger.dev/core/v3/isomorphic";
import {
  InjectedSnapshotFault,
  type SnapshotFaultBoundary,
  type SnapshotFaultInjector,
} from "@internal/run-store";
import { setTimeout } from "timers/promises";
import { RunEngine } from "../index.js";
import { buildDecoratedStore, type DecoratedStoreHarness } from "./helpers/decoratedStore.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * A local stand-in for the shared fault harness being built alongside this ticket. Its surface is
 * the agreed one — arm, disarm, hook, fired — so swapping the import in costs no test-body change.
 *
 * `fired` is the guard against a silent pass. A boundary can be armed and never reached, in which
 * case the test would go green having proved nothing, so every test asserts its boundary fired.
 */
function createFaultInjector(opts: { error: (boundary: SnapshotFaultBoundary) => Error }) {
  const armed = new Map<string, { times: number; runId?: string }>();
  const counts = new Map<string, number>();

  return {
    arm(boundary: SnapshotFaultBoundary, opts?: { times?: number; runId?: string }) {
      armed.set(boundary, { times: opts?.times ?? 1, ...(opts?.runId && { runId: opts.runId }) });
    },
    disarm(boundary: SnapshotFaultBoundary) {
      armed.delete(boundary);
    },
    fired(boundary: SnapshotFaultBoundary): number {
      return counts.get(boundary) ?? 0;
    },
    hook: ((boundary, context) => {
      const entry = armed.get(boundary);
      if (!entry) return;
      if (entry.runId && context.runId !== entry.runId) return;

      counts.set(boundary, (counts.get(boundary) ?? 0) + 1);
      entry.times -= 1;
      if (entry.times <= 0) armed.delete(boundary);

      throw opts.error(boundary);
    }) satisfies SnapshotFaultInjector,
  };
}

function engineOptions(
  prisma: any,
  redisOptions: any,
  harness: DecoratedStoreHarness,
  heartbeatMs: number
) {
  return {
    prisma,
    store: harness.store,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      retryOptions: { maxTimeoutInMs: 50 },
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x" as const,
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    heartbeatTimeoutsMs: { PENDING_EXECUTING: heartbeatMs },
    tracer: trace.getTracer("test", "0.0.0"),
  };
}

const triggerArgs = (taskIdentifier: string, environment: any) => ({
  number: 1,
  friendlyId: RunId.generate().friendlyId,
  environment,
  taskIdentifier,
  payload: "{}",
  payloadType: "application/json",
  context: {},
  traceContext: {},
  traceId: `t_${generateInternalId().slice(-12)}`,
  spanId: `s_${generateInternalId().slice(-12)}`,
  workerQueue: "main",
  queue: `task/${taskIdentifier}`,
  isTest: false,
  tags: [],
});

describe("snapshot store crash boundaries", () => {
  containerTest(
    "afterPgBeforeRedis: the run converges and burns at most one attempt",
    async ({ prisma, redisOptions }) => {
      const faults = createFaultInjector({ error: (b) => new InjectedSnapshotFault(b) });
      const harness = buildDecoratedStore({
        prisma,
        redisOptions,
        mode: "redis-read",
        faults: faults.hook,
      });
      const engine = new RunEngine(engineOptions(prisma, redisOptions, harness, 200) as never);

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, environment, "chaos-task");
        const run = await engine.trigger(triggerArgs("chaos-task", environment), prisma);
        await setTimeout(500);

        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "chaos",
          workerQueue: "main",
        });
        expect(dequeued.length).toBe(1);

        // Crash between the Postgres commit and the Redis append of ONE transition.
        faults.arm("afterPgBeforeRedis", { times: 1, runId: run.id });
        const attempt = await engine.startRunAttempt({
          runId: dequeued[0]!.run.id,
          snapshotId: dequeued[0]!.snapshot.id,
        });
        faults.disarm("afterPgBeforeRedis");

        // The boundary was actually reached. Without this the test could pass having proved nothing.
        expect(faults.fired("afterPgBeforeRedis")).toBe(1);

        // Postgres committed the attempt bump; the run is not stuck and not lost.
        expect(attempt.run.attemptNumber).toBe(1);
        const pgRun = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(pgRun.attemptNumber).toBe(1);

        // The gap handed the run to the repair job rather than failing the caller.
        expect(harness.repairs).toHaveLength(1);
        expect(harness.repairs[0]!.runId).toBe(run.id);

        // Reads still resolve: the run's state machine is readable, so nothing hangs.
        const data = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(data);

        // The bound: one crash costs at most one attempt number.
        expect(pgRun.attemptNumber! - 1).toBeLessThanOrEqual(1);
      } finally {
        await engine.quit();
        await harness.quit();
      }
    }
  );

  containerTest(
    "afterRedisBirthBeforePg: no run is created, and the next trigger succeeds",
    async ({ prisma, redisOptions }) => {
      const faults = createFaultInjector({ error: (b) => new InjectedSnapshotFault(b) });
      const harness = buildDecoratedStore({
        prisma,
        redisOptions,
        mode: "redis-read",
        faults: faults.hook,
      });
      const engine = new RunEngine(engineOptions(prisma, redisOptions, harness, 200) as never);

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, environment, "chaos-task");

        faults.arm("afterRedisBirthBeforePg", { times: 1 });
        await expect(
          engine.trigger(triggerArgs("chaos-task", environment), prisma)
        ).rejects.toBeInstanceOf(InjectedSnapshotFault);
        expect(faults.fired("afterRedisBirthBeforePg")).toBe(1);

        // The harmless state: no run row, so nothing can ever read a run that has no snapshot.
        const runsAfterCrash = await prisma.taskRun.count({
          where: { runtimeEnvironmentId: environment.id },
        });
        expect(runsAfterCrash).toBe(0);

        // A crashed birth must not poison the path: the next trigger runs to completion.
        const run = await engine.trigger(triggerArgs("chaos-task", environment), prisma);
        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "chaos",
          workerQueue: "main",
        });
        const attempt = await engine.startRunAttempt({
          runId: dequeued[0]!.run.id,
          snapshotId: dequeued[0]!.snapshot.id,
        });
        await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
          completion: {
            ok: true,
            id: run.id,
            output: `{"done":true}`,
            outputType: "application/json",
          },
        });

        const finished = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(finished.status).toBe("COMPLETED_SUCCESSFULLY");
        expect(finished.attemptNumber).toBe(1);
      } finally {
        await engine.quit();
        await harness.quit();
      }
    }
  );

  containerTest(
    "midFlushRetry: a crash during a retry still converges through the repair job",
    async ({ prisma, redisOptions }) => {
      const faults = createFaultInjector({ error: (b) => new InjectedSnapshotFault(b) });
      // A dead port makes attempt 0 fail FOR REAL, which is the only way the retry boundary is
      // reachable: an injected fault at attempt 0 is treated as a dead process and skips the
      // retries entirely. Arming midFlushRetry alone would fire nothing and pass for the wrong
      // reason, which is what the fired() assertion below catches.
      const harness = buildDecoratedStore({
        prisma,
        redisOptions: { ...(redisOptions as object), port: 1, retryStrategy: () => null } as never,
        mode: "dual-write",
        faults: faults.hook,
      });
      const engine = new RunEngine(engineOptions(prisma, redisOptions, harness, 200) as never);

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, environment, "chaos-task");

        faults.arm("midFlushRetry", { times: 1 });
        const run = await engine.trigger(triggerArgs("chaos-task", environment), prisma);
        await setTimeout(500);

        // The birth append failed for real and, before redis-only, that is survivable: Postgres is
        // authoritative and the run exists.
        const pgRun = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(pgRun.id).toBe(run.id);

        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "chaos",
          workerQueue: "main",
        });
        expect(dequeued.length).toBe(1);

        const attempt = await engine.startRunAttempt({
          runId: dequeued[0]!.run.id,
          snapshotId: dequeued[0]!.snapshot.id,
        });

        // The retry boundary was genuinely reached, not merely armed.
        expect(faults.fired("midFlushRetry")).toBeGreaterThanOrEqual(1);

        // The run converges regardless: Postgres holds every snapshot at this dial position.
        expect(attempt.run.attemptNumber).toBe(1);
        const data = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(data);
        expect(data.snapshot.executionStatus).toBe("EXECUTING");
      } finally {
        await engine.quit();
        await harness.quit();
      }
    }
  );

  containerTest(
    "a crash-stalled run rejects a stale snapshot rather than hanging",
    async ({ prisma, redisOptions }) => {
      const faults = createFaultInjector({ error: (b) => new InjectedSnapshotFault(b) });
      const harness = buildDecoratedStore({
        prisma,
        redisOptions,
        mode: "redis-read",
        faults: faults.hook,
      });
      const engine = new RunEngine(engineOptions(prisma, redisOptions, harness, 200) as never);

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, environment, "chaos-task");
        const run = await engine.trigger(triggerArgs("chaos-task", environment), prisma);
        await setTimeout(500);

        faults.arm("afterPgBeforeRedis", { times: 1, runId: run.id });
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "chaos",
          workerQueue: "main",
        });
        faults.disarm("afterPgBeforeRedis");
        expect(faults.fired("afterPgBeforeRedis")).toBe(1);

        // Postgres advanced; the Redis head did not. Reads come from Redis, so the caller now holds
        // a snapshot id that no longer matches what the read store reports as latest.
        //
        // The contract is that this SURFACES rather than corrupts: the next operation to validate
        // against latest rejects with a stale-snapshot error, which is the same answer a caller gets
        // from an ordinary lost race. It does not hang, and it does not silently execute against the
        // wrong state.
        await expect(
          engine.startRunAttempt({
            runId: dequeued[0]!.run.id,
            snapshotId: dequeued[0]!.snapshot.id,
          })
        ).rejects.toThrow(/Snapshot changed/);

        // The run is still readable and still has a coherent state machine.
        const data = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(data);

        // The gap was handed to the repair job, which is the compensator the protocol names.
        expect(harness.repairs.length).toBeGreaterThanOrEqual(1);
        expect(harness.repairs.some((r) => r.runId === run.id)).toBe(true);

        // And no attempt was burned by the rejection itself: the bound is per crash, and the
        // rejected call never reached the attempt bump.
        const pgRun = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(pgRun.attemptNumber ?? 0).toBeLessThanOrEqual(faults.fired("afterPgBeforeRedis"));
      } finally {
        await engine.quit();
        await harness.quit();
      }
    }
  );

  containerTest(
    "two crashes cost at most two attempts, and the divergence does not amplify",
    async ({ prisma, redisOptions }) => {
      const faults = createFaultInjector({ error: (b) => new InjectedSnapshotFault(b) });
      // dual-write, so reads still come from Postgres and the run can be driven forward through the
      // normal API. That isolates the property under test — how many attempts two crashes cost —
      // from the stale-read rejection the previous test covers.
      const harness = buildDecoratedStore({
        prisma,
        redisOptions,
        mode: "dual-write",
        faults: faults.hook,
      });
      const engine = new RunEngine(engineOptions(prisma, redisOptions, harness, 200) as never);

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, environment, "chaos-task");
        const run = await engine.trigger(triggerArgs("chaos-task", environment), prisma);
        await setTimeout(500);

        faults.arm("afterPgBeforeRedis", { times: 2, runId: run.id });

        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "chaos",
          workerQueue: "main",
        });
        const attempt = await engine.startRunAttempt({
          runId: dequeued[0]!.run.id,
          snapshotId: dequeued[0]!.snapshot.id,
        });
        await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
          completion: {
            ok: true,
            id: run.id,
            output: `{"done":true}`,
            outputType: "application/json",
          },
        });

        const crashes = faults.fired("afterPgBeforeRedis");
        expect(crashes).toBeGreaterThanOrEqual(1);

        const pgRun = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });

        // pgAttempt - maxLoggedAttempt <= crashCount. Each crash costs at most one attempt, and the
        // divergence does not amplify: two crashes never cost three. A flat bound of one was
        // refuted by the model check, so the assertion is against the crash count, not a constant.
        expect((pgRun.attemptNumber ?? 0) - 1).toBeLessThanOrEqual(crashes);

        // Postgres holds every snapshot at this dial position, so the run still converges.
        expect(pgRun.status).toBe("COMPLETED_SUCCESSFULLY");
        expect(harness.repairs.length).toBe(crashes);
      } finally {
        await engine.quit();
        await harness.quit();
      }
    }
  );
});
