import { containerTest } from "@internal/testcontainers";
import type { Meter } from "@internal/tracing";
import { trace } from "@internal/tracing";
import { createRedisClient, type RedisOptions } from "@internal/redis";
import type { TaskRunError, TaskRunExecutionResult } from "@trigger.dev/core/v3";
import type { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { RETURNED_WHILE_RESUMING_ERROR } from "../staleCompletions.js";
import type { RunEngineOptions } from "../types.js";
import { createTestMetricsMeter } from "./helpers/replicaTestHelpers.js";
import {
  type AuthenticatedEnvironment,
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
} from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

// A runner posts its completion with the last snapshot id it has processed. The engine makes
// snapshots of its own (a waitpoint completes, the run is continued after a restore, a suspend is
// recorded), so that id can be behind.
//
// When the latest snapshot is the engine's own continue of the one the completion names, the
// sender is the process that owns the run and it has said its task is over. The engine settles the
// attempt at once: a success fails with an error that says the task returned while its run was
// resuming from a wait, a failure keeps its own error and retry rules. Every other stale
// completion is refused. When it came from the runner that owns the latest snapshot it is also
// noted, so that a stall afterwards says why instead of out of memory.
//
// That is the engine's "enforce" mode. In "count" (the default) and "classify" every stale
// completion is refused as before, and a counter says what "enforce" would have done.

const taskIdentifier = "test-task";
const runnerId = "runner_1";
const executingHeartbeatTimeoutMs = 1_500;

function createEngine(
  prisma: PrismaClient,
  redisOptions: RedisOptions,
  options: {
    staleCompletionMode: NonNullable<RunEngineOptions["staleCompletionMode"]>;
    meter?: Meter;
  }
) {
  return new RunEngine({
    ...options,
    prisma,
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
      },
      baseCostInCents: 0.0001,
    },
    heartbeatTimeoutsMs: {
      EXECUTING: executingHeartbeatTimeoutMs,
      PENDING_CANCEL: 500,
    },
    treatProductionExecutionStallsAsOOM: true,
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

async function dequeue(engine: RunEngine, environment: AuthenticatedEnvironment) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    await engine.runQueue.processMasterQueueForEnvironment(environment.id, 1);
    const [dequeued] = await engine.dequeueFromWorkerQueue({
      consumerId: "test_12345",
      workerQueue: "main",
      blockingPopTimeoutSeconds: 1,
    });
    if (dequeued) {
      return dequeued;
    }
    await setTimeout(50);
  }

  throw new Error("the run was never dequeued");
}

/** Triggers a run and starts its first attempt: EXECUTING. */
async function startAttempt(
  engine: RunEngine,
  prisma: PrismaClient,
  environment: AuthenticatedEnvironment
) {
  await setupBackgroundWorker(engine, environment, taskIdentifier);

  const run = await engine.trigger(
    {
      number: 1,
      friendlyId: `run_${Math.random().toString(36).slice(2, 10)}`,
      environment,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t12345",
      spanId: "s12345",
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
    },
    prisma
  );

  const dequeued = await dequeue(engine, environment);
  const started = await engine.startRunAttempt({
    runId: run.id,
    snapshotId: dequeued.snapshot.id,
    runnerId,
  });

  return { runId: run.id, executingSnapshotId: started.snapshot.id };
}

/** Starts an attempt and blocks it on a manual waitpoint: EXECUTING_WITH_WAITPOINTS. */
async function startAttemptBlockedOnWaitpoint(
  engine: RunEngine,
  prisma: PrismaClient,
  environment: AuthenticatedEnvironment
) {
  const { runId } = await startAttempt(engine, prisma, environment);
  return { runId, ...(await blockOnWaitpoint(engine, environment, runId)) };
}

async function blockOnWaitpoint(
  engine: RunEngine,
  environment: AuthenticatedEnvironment,
  runId: string
) {
  const { waitpoint } = await engine.createManualWaitpoint({
    environmentId: environment.id,
    projectId: environment.projectId,
  });

  const blocked = await engine.blockRunWithWaitpoint({
    runId,
    waitpoints: waitpoint.id,
    projectId: environment.projectId,
    organizationId: environment.organizationId,
    runnerId,
  });
  expect(blocked.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

  return { waitpointId: waitpoint.id, blockedSnapshotId: blocked.id };
}

async function waitForSnapshot(
  engine: RunEngine,
  runId: string,
  matches: (snapshot: { id: string; executionStatus: string }) => boolean
) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const data = await engine.getRunExecutionData({ runId });
    if (data && matches(data.snapshot)) {
      return data;
    }
    await setTimeout(25);
  }

  throw new Error("the run never reached the expected snapshot");
}

function recordEvents(engine: RunEngine) {
  const events: Array<{ event: string; error?: TaskRunError }> = [];
  engine.eventBus.on("runAttemptFailed", ({ run }) =>
    events.push({ event: "runAttemptFailed", error: run.error })
  );
  engine.eventBus.on("runFailed", ({ run }) =>
    events.push({ event: "runFailed", error: run.error })
  );
  engine.eventBus.on("runRetryScheduled", ({ run }) =>
    events.push({ event: "runRetryScheduled", error: run.error })
  );
  engine.eventBus.on("runSucceeded", () => events.push({ event: "runSucceeded" }));
  return events;
}

const success = (runId: string): TaskRunExecutionResult => ({
  ok: true,
  id: runId,
  output: `{"foo":"bar"}`,
  outputType: "application/json",
  usage: { durationMs: 2_000 },
});

const failure = (runId: string): TaskRunExecutionResult => ({
  ok: false,
  id: runId,
  error: { type: "BUILT_IN_ERROR", name: "UserError", message: "boom", stackTrace: "" },
  retry: { timestamp: Date.now(), delay: 0 },
});

async function complete(
  engine: RunEngine,
  runId: string,
  snapshotId: string,
  completion: TaskRunExecutionResult,
  fromRunnerId = runnerId
) {
  return engine
    .completeRunAttempt({ runId, snapshotId, runnerId: fromRunnerId, completion })
    .catch((error: unknown) => error);
}

const refusal = (latestSnapshotId: string) => ({
  name: "ServiceValidationError",
  message: "Snapshot ID doesn't match the latest snapshot",
  status: 400,
  metadata: { code: "SNAPSHOT_CONFLICT", latestSnapshotId },
});

/** The notes of refused completions that the engine has in Redis. */
async function readNoteKeys(redisOptions: RedisOptions) {
  const redis = createRedisClient(redisOptions, { onError: () => {} });
  try {
    return await redis.keys("*stale-completion:*");
  } finally {
    await redis.quit();
  }
}

async function readRun(prisma: PrismaClient, runId: string) {
  return prisma.taskRun.findUniqueOrThrow({
    where: { id: runId },
    select: { status: true, error: true, output: true, attemptNumber: true, usageDurationMs: true },
  });
}

/** A success one step behind an engine-made continue: failed at once, clearly, with no retry. */
async function expectSuccessSettledAsReturnedWhileResuming({
  engine,
  prisma,
  runId,
  staleSnapshotId,
}: {
  engine: RunEngine;
  prisma: PrismaClient;
  runId: string;
  staleSnapshotId: string;
}) {
  const events = recordEvents(engine);

  // Answered like any completion, so a runner in the field stops instead of retrying.
  const settled = await complete(engine, runId, staleSnapshotId, success(runId));
  expect(settled).toMatchObject({
    attemptStatus: "RUN_FINISHED",
    snapshot: { executionStatus: "FINISHED" },
    run: { status: "CRASHED" },
  });

  const run = await readRun(prisma, runId);
  expect(run).toMatchObject({
    status: "CRASHED",
    output: null,
    attemptNumber: 1,
    // The attempt's compute is still billed.
    usageDurationMs: 2_000,
    error: RETURNED_WHILE_RESUMING_ERROR,
  });

  // The task's code ran to its end once, so there is no retry.
  expect(events).toEqual([{ event: "runFailed", error: RETURNED_WHILE_RESUMING_ERROR }]);

  // A replay finds the run finished and is refused, as any replay is.
  const replay = await complete(engine, runId, staleSnapshotId, success(runId));
  expect(replay).toMatchObject({ status: 400, metadata: { code: "SNAPSHOT_CONFLICT" } });
  expect(events).toHaveLength(1);
}

/** Suspends a blocked run, completes its waitpoint and continues it as the restored runner. */
async function suspendAndRestore(
  engine: RunEngine,
  environment: AuthenticatedEnvironment,
  {
    runId,
    waitpointId,
    blockedSnapshotId,
  }: Awaited<ReturnType<typeof startAttemptBlockedOnWaitpoint>>
) {
  const checkpoint = await engine.createCheckpoint({
    runId,
    snapshotId: blockedSnapshotId,
    checkpoint: {
      type: "DOCKER",
      reason: "TEST_CHECKPOINT",
      location: "test-location",
      imageRef: "test-image-ref",
    },
  });
  if (!checkpoint.ok || checkpoint.snapshot.executionStatus !== "SUSPENDED") {
    throw new Error("the run was not suspended");
  }

  const restore = async (restoredRunnerId = runnerId) => {
    // The waitpoint completes, the run is queued and dequeued for its restore.
    await engine.completeWaitpoint({ id: waitpointId });
    const dequeued = await dequeue(engine, environment);
    expect(dequeued.snapshot.executionStatus).toBe("PENDING_EXECUTING");

    // The restored runner continues with the PENDING_EXECUTING id, which creates EXECUTING.
    const continued = await engine.continueRunExecution({
      runId,
      snapshotId: dequeued.snapshot.id,
      runnerId: restoredRunnerId,
    });
    expect(continued.snapshot.executionStatus).toBe("EXECUTING");

    return { pendingSnapshotId: dequeued.snapshot.id, continuedSnapshotId: continued.snapshot.id };
  };

  return { suspendedSnapshotId: checkpoint.snapshot.id, restore };
}

describe("RunEngine completion one step behind the engine's own continue", () => {
  // Catches: a task that returned while its waitpoint was completing being refused, then failed
  // as out of memory when the heartbeat timed out.
  containerTest(
    "success posted with the pre-unblock snapshot id fails the run at once with a clear error",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions, { staleCompletionMode: "enforce" });

      try {
        const { runId, waitpointId, blockedSnapshotId } = await startAttemptBlockedOnWaitpoint(
          engine,
          prisma,
          environment
        );

        // The waitpoint completes and the engine moves the run back to EXECUTING by itself.
        await engine.completeWaitpoint({ id: waitpointId });
        const unblocked = await waitForSnapshot(
          engine,
          runId,
          (snapshot) =>
            snapshot.id !== blockedSnapshotId && snapshot.executionStatus === "EXECUTING"
        );

        // Another runner naming that snapshot is not the process that owns the run.
        const stranger = await complete(
          engine,
          runId,
          blockedSnapshotId,
          success(runId),
          "runner_other"
        );
        expect(stranger).toMatchObject(refusal(unblocked.snapshot.id));

        await expectSuccessSettledAsReturnedWhileResuming({
          engine,
          prisma,
          runId,
          staleSnapshotId: blockedSnapshotId,
        });
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: API-driven waits losing ownership and accepting another runner's stale completion.
  containerTest(
    "API-driven wait refuses a different runner's stale completion while the owner settles",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions, { staleCompletionMode: "enforce" });

      try {
        const { runId } = await startAttempt(engine, prisma, environment);
        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: environment.id,
          projectId: environment.projectId,
        });
        const blocked = await engine.blockRunWithWaitpoint({
          runId,
          waitpoints: waitpoint.id,
          projectId: environment.projectId,
          organizationId: environment.organizationId,
        });

        await engine.completeWaitpoint({ id: waitpoint.id });
        const unblocked = await waitForSnapshot(
          engine,
          runId,
          (snapshot) => snapshot.id !== blocked.id && snapshot.executionStatus === "EXECUTING"
        );

        const stranger = await complete(engine, runId, blocked.id, success(runId), "runner_other");
        expect(stranger).toMatchObject(refusal(unblocked.snapshot.id));

        await expectSuccessSettledAsReturnedWhileResuming({
          engine,
          prisma,
          runId,
          staleSnapshotId: blocked.id,
        });
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: the same for a task that returned right after a restore, before its runner had taken
  // in the snapshot that continuing created.
  containerTest(
    "success posted with the pre-continue snapshot id fails the run at once with a clear error",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions, { staleCompletionMode: "enforce" });

      try {
        const blocked = await startAttemptBlockedOnWaitpoint(engine, prisma, environment);
        const { restore } = await suspendAndRestore(engine, environment, blocked);
        const { pendingSnapshotId, continuedSnapshotId } = await restore();

        // Only the runner that continued the run can be the one that returned.
        const stranger = await complete(
          engine,
          blocked.runId,
          pendingSnapshotId,
          success(blocked.runId),
          "runner_other"
        );
        expect(stranger).toMatchObject(refusal(continuedSnapshotId));

        await expectSuccessSettledAsReturnedWhileResuming({
          engine,
          prisma,
          runId: blocked.runId,
          staleSnapshotId: pendingSnapshotId,
        });
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: the same for a run that went back to the queue while its process kept running.
  // Dequeuing it is also the engine's own continue.
  containerTest(
    "success posted with the pre-dequeue snapshot id of a still-executing run fails the run at once with a clear error",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions, { staleCompletionMode: "enforce" });

      try {
        const { runId, executingSnapshotId } = await startAttempt(engine, prisma, environment);

        const queued = await engine.enqueueSystem.enqueueRun({
          run: await prisma.taskRun.findUniqueOrThrow({ where: { id: runId } }),
          env: environment,
          snapshot: { status: "QUEUED_EXECUTING" },
          previousSnapshotId: executingSnapshotId,
          runnerId,
        });
        expect(queued.executionStatus).toBe("QUEUED_EXECUTING");

        // Nothing is handed to a worker: the run only moves back to EXECUTING.
        const deadline = performance.now() + 10_000;
        let latest = await engine.getRunExecutionData({ runId });
        while (latest?.snapshot.executionStatus !== "EXECUTING" && performance.now() < deadline) {
          await engine.runQueue.processMasterQueueForEnvironment(environment.id, 1);
          await engine.dequeueFromWorkerQueue({
            consumerId: "test_12345",
            workerQueue: "main",
            blockingPopTimeoutSeconds: 1,
          });
          latest = await engine.getRunExecutionData({ runId });
        }
        expect(latest?.snapshot.executionStatus).toBe("EXECUTING");

        await expectSuccessSettledAsReturnedWhileResuming({
          engine,
          prisma,
          runId,
          staleSnapshotId: queued.id,
        });
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: a task that threw in the same window losing its own error, or its retries.
  containerTest(
    "failure posted with the pre-unblock snapshot id keeps its own error and retries",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions, { staleCompletionMode: "enforce" });

      try {
        const { runId, waitpointId, blockedSnapshotId } = await startAttemptBlockedOnWaitpoint(
          engine,
          prisma,
          environment
        );
        await engine.completeWaitpoint({ id: waitpointId });
        await waitForSnapshot(
          engine,
          runId,
          (snapshot) =>
            snapshot.id !== blockedSnapshotId && snapshot.executionStatus === "EXECUTING"
        );
        const events = recordEvents(engine);

        const settled = await complete(engine, runId, blockedSnapshotId, failure(runId));
        expect(settled).toMatchObject({
          attemptStatus: "RETRY_IMMEDIATELY",
          snapshot: { executionStatus: "EXECUTING" },
        });
        expect(events).toEqual([
          { event: "runRetryScheduled", error: expect.objectContaining({ message: "boom" }) },
        ]);
      } finally {
        await engine.quit();
      }
    }
  );
});

describe("RunEngine stale completion that is refused", () => {
  // Catches: a completion from the process a checkpoint was taken of ending the run that its
  // restored copy carries on with.
  containerTest(
    "the pre-suspend snapshot id is refused while suspended and after the restore, and the restored copy completes",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions, { staleCompletionMode: "enforce" });

      try {
        const blocked = await startAttemptBlockedOnWaitpoint(engine, prisma, environment);
        const { runId, blockedSnapshotId } = blocked;
        const { suspendedSnapshotId, restore } = await suspendAndRestore(
          engine,
          environment,
          blocked
        );
        const events = recordEvents(engine);

        // The original process outlives the checkpoint by a few seconds and returns.
        const whileSuspended = await complete(engine, runId, blockedSnapshotId, success(runId));
        expect(whileSuspended).toMatchObject(refusal(suspendedSnapshotId));
        expect((await engine.getRunExecutionData({ runId }))?.snapshot.executionStatus).toBe(
          "SUSPENDED"
        );

        const { continuedSnapshotId } = await restore();
        const afterRestore = await complete(engine, runId, blockedSnapshotId, success(runId));
        expect(afterRestore).toMatchObject(refusal(continuedSnapshotId));
        expect(events).toEqual([]);

        // The restored copy finishes its task and completes with the snapshot it holds.
        const completed = await complete(engine, runId, continuedSnapshotId, success(runId));
        expect(completed).toMatchObject({ attemptStatus: "RUN_FINISHED" });
        expect(await readRun(prisma, runId)).toMatchObject({
          status: "COMPLETED_SUCCESSFULLY",
          output: `{"foo":"bar"}`,
        });
        expect(events).toEqual([{ event: "runSucceeded" }]);
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: a run whose task returned, and whose completion was refused, being failed as out of
  // memory when the heartbeat times out.
  containerTest(
    "a stall after a refused success says the task returned, not out of memory",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions, { staleCompletionMode: "enforce" });

      try {
        const blocked = await startAttemptBlockedOnWaitpoint(engine, prisma, environment);
        const { runId, blockedSnapshotId } = blocked;
        const { restore } = await suspendAndRestore(engine, environment, blocked);
        const { continuedSnapshotId } = await restore();
        const events = recordEvents(engine);

        // The restored runner returns before it has taken in any snapshot since its checkpoint.
        const refused = await complete(engine, runId, blockedSnapshotId, success(runId));
        expect(refused).toMatchObject(refusal(continuedSnapshotId));
        expect(events).toEqual([]);
        expect(await readNoteKeys(redisOptions)).toHaveLength(1);

        // Nothing heartbeats the EXECUTING snapshot, so the stall handler takes the run.
        await waitForSnapshot(engine, runId, (snapshot) => snapshot.executionStatus === "FINISHED");

        expect(await readRun(prisma, runId)).toMatchObject({
          status: "CRASHED",
          output: null,
          attemptNumber: 1,
          error: RETURNED_WHILE_RESUMING_ERROR,
        });
        expect(events).toEqual([{ event: "runFailed", error: RETURNED_WHILE_RESUMING_ERROR }]);
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: a restored copy that stalls being told its task returned, because the process it was
  // copied from had a completion refused after the restore.
  containerTest(
    "a stall after a refused success from the process the checkpoint was taken of is still reported as out of memory",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions, { staleCompletionMode: "enforce" });

      try {
        const blocked = await startAttemptBlockedOnWaitpoint(engine, prisma, environment);
        const { runId, blockedSnapshotId } = blocked;
        const { restore } = await suspendAndRestore(engine, environment, blocked);
        // The restored copy runs under a runner id of its own.
        const { continuedSnapshotId } = await restore("runner_1_restored");
        const events = recordEvents(engine);

        // The original process outlives its checkpoint and returns after the restore.
        const refused = await complete(engine, runId, blockedSnapshotId, success(runId));
        expect(refused).toMatchObject(refusal(continuedSnapshotId));

        // The copy never heartbeats. That stall is its own, not the original's return.
        await waitForSnapshot(engine, runId, (snapshot) => snapshot.executionStatus === "FINISHED");

        expect(await readRun(prisma, runId)).toMatchObject({
          status: "CRASHED",
          error: { type: "INTERNAL_ERROR", code: "TASK_PROCESS_OOM_KILLED" },
        });
        expect(events.map((e) => e.event)).toEqual(["runAttemptFailed", "runFailed"]);
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: a stall with no refused completion behind it losing its ordinary error.
  containerTest(
    "a stall with no refused completion is still reported as out of memory",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions, { staleCompletionMode: "enforce" });

      try {
        const { runId } = await startAttempt(engine, prisma, environment);
        const events = recordEvents(engine);

        await waitForSnapshot(engine, runId, (snapshot) => snapshot.executionStatus === "FINISHED");

        expect(await readRun(prisma, runId)).toMatchObject({
          status: "CRASHED",
          error: { type: "INTERNAL_ERROR", code: "TASK_PROCESS_OOM_KILLED" },
        });
        expect(events.map((e) => e.event)).toEqual(["runAttemptFailed", "runFailed"]);
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: a replayed failure, whose first try already started a retry, ending the next attempt.
  containerTest(
    "a replayed failure that already started a retry is refused and the next attempt completes",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions, { staleCompletionMode: "enforce" });

      try {
        const { runId, executingSnapshotId } = await startAttempt(engine, prisma, environment);
        const completion = failure(runId);

        const first = await engine.completeRunAttempt({
          runId,
          snapshotId: executingSnapshotId,
          runnerId,
          completion,
        });
        expect(first.attemptStatus).toBe("RETRY_IMMEDIATELY");

        const replay = await complete(engine, runId, executingSnapshotId, completion);
        expect(replay).toMatchObject(refusal(first.snapshot.id));

        const second = await engine.startRunAttempt({
          runId,
          snapshotId: first.snapshot.id,
          runnerId,
        });
        const completed = await complete(engine, runId, second.snapshot.id, success(runId));
        expect(completed).toMatchObject({ attemptStatus: "RUN_FINISHED" });
        expect(await readRun(prisma, runId)).toMatchObject({
          status: "COMPLETED_SUCCESSFULLY",
          attemptNumber: 2,
        });
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: a completion that crosses a cancel finishing the run in place of the cancel.
  containerTest(
    "a completion naming the snapshot before a cancel is refused and the run ends canceled",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions, { staleCompletionMode: "enforce" });

      try {
        const { runId, executingSnapshotId } = await startAttempt(engine, prisma, environment);

        await engine.cancelRun({ runId });
        const canceling = await engine.getRunExecutionData({ runId });
        expect(canceling?.snapshot.executionStatus).toBe("PENDING_CANCEL");

        const refused = await complete(engine, runId, executingSnapshotId, success(runId));
        expect(refused).toMatchObject(refusal(canceling!.snapshot.id));

        // Nothing acknowledges the cancel, so its own heartbeat finishes the run.
        await waitForSnapshot(engine, runId, (snapshot) => snapshot.executionStatus === "FINISHED");
        expect(await readRun(prisma, runId)).toMatchObject({ status: "CANCELED", output: null });
      } finally {
        await engine.quit();
      }
    }
  );
});

// Catches: a deploy that has not switched the new behaviour on failing runs it used to refuse,
// changing the error of a stall, or adding a database read or a Redis call to a completion.
describe.each([
  {
    staleCompletionMode: "count",
    // Without a read of the named snapshot, a completion from another runner can't be told apart.
    counted: {
      "waitpoint_continue_unverified would_settle": 2,
      "restore_continue would_settle": 1,
    },
  },
  {
    staleCompletionMode: "classify",
    counted: {
      "waitpoint_continue would_settle": 1,
      "other refused": 1,
      "restore_continue would_settle": 1,
    },
  },
] as const)(
  "RunEngine stale completion in $staleCompletionMode mode",
  ({ staleCompletionMode, counted }) => {
    containerTest(
      "a success one step behind the engine's own continue is refused as before and counted as one that would settle",
      async ({ prisma, redisOptions }) => {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { meter, getCounterValue } = createTestMetricsMeter();
        const engine = createEngine(prisma, redisOptions, { staleCompletionMode, meter });

        try {
          const { runId, waitpointId, blockedSnapshotId } = await startAttemptBlockedOnWaitpoint(
            engine,
            prisma,
            environment
          );
          const events = recordEvents(engine);

          // The waitpoint completes and the engine moves the run back to EXECUTING by itself.
          await engine.completeWaitpoint({ id: waitpointId });
          const unblocked = await waitForSnapshot(
            engine,
            runId,
            (snapshot) =>
              snapshot.id !== blockedSnapshotId && snapshot.executionStatus === "EXECUTING"
          );
          for (const sender of [runnerId, "runner_other"]) {
            const refused = await complete(
              engine,
              runId,
              blockedSnapshotId,
              success(runId),
              sender
            );
            expect(refused).toMatchObject(refusal(unblocked.snapshot.id));
          }

          // The run waits again, is suspended, and its restored runner continues it.
          const blockedAgain = await blockOnWaitpoint(engine, environment, runId);
          const { restore } = await suspendAndRestore(engine, environment, {
            runId,
            ...blockedAgain,
          });
          const { pendingSnapshotId, continuedSnapshotId } = await restore();
          const refused = await complete(engine, runId, pendingSnapshotId, success(runId));
          expect(refused).toMatchObject(refusal(continuedSnapshotId));

          for (const [key, value] of Object.entries(counted)) {
            const [rule, result] = key.split(" ");
            expect(
              await getCounterValue("run_engine.stale_completions", {
                mode: staleCompletionMode,
                rule,
                result,
              }),
              key
            ).toBe(value);
          }
          expect(await getCounterValue("run_engine.stale_completions")).toBe(3);
          expect(await readNoteKeys(redisOptions)).toEqual([]);
          expect(events).toEqual([]);

          // The run is as it was: its process completes with the snapshot it holds.
          const completed = await complete(engine, runId, continuedSnapshotId, success(runId));
          expect(completed).toMatchObject({ attemptStatus: "RUN_FINISHED" });
          expect(await readRun(prisma, runId)).toMatchObject({
            status: "COMPLETED_SUCCESSFULLY",
            output: `{"foo":"bar"}`,
          });
          expect(events).toEqual([{ event: "runSucceeded" }]);
        } finally {
          await engine.quit();
        }
      }
    );

    containerTest(
      "a stall after a refused success is still reported as out of memory",
      async ({ prisma, redisOptions }) => {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const engine = createEngine(prisma, redisOptions, { staleCompletionMode });

        try {
          const blocked = await startAttemptBlockedOnWaitpoint(engine, prisma, environment);
          const { runId, blockedSnapshotId } = blocked;
          const { restore } = await suspendAndRestore(engine, environment, blocked);
          const { continuedSnapshotId } = await restore();
          const events = recordEvents(engine);

          // The refusal that "enforce" notes for the stall handler: here nothing is noted.
          const refused = await complete(engine, runId, blockedSnapshotId, success(runId));
          expect(refused).toMatchObject(refusal(continuedSnapshotId));
          expect(await readNoteKeys(redisOptions)).toEqual([]);

          await waitForSnapshot(
            engine,
            runId,
            (snapshot) => snapshot.executionStatus === "FINISHED"
          );

          expect(await readRun(prisma, runId)).toMatchObject({
            status: "CRASHED",
            error: { type: "INTERNAL_ERROR", code: "TASK_PROCESS_OOM_KILLED" },
          });
          expect(events.map((e) => e.event)).toEqual(["runAttemptFailed", "runFailed"]);
        } finally {
          await engine.quit();
        }
      }
    );
  }
);
