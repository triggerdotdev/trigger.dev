import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout } from "node:timers/promises";
import { expect, vi } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * The ensureRunFinalized write-ahead guard: enqueued before every run-finish commit,
 * acked when the inline side effects (waitpoint completion, unblock fan-out, batch
 * nudge) all succeed, and re-delivering them when the inline path died in between.
 * Reproduces the 2026-08-29 incident shape: a DB error after the finish commit left a
 * RUN waitpoint PENDING forever and the parent blocked.
 */
describe("RunEngine ensureRunFinalized guard", () => {
  function createEngine(prisma: any, redisOptions: any) {
    return new RunEngine({
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
        ttlSystem: {
          pollIntervalMs: 100,
          batchSize: 10,
          batchMaxWaitMs: 100,
        },
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
      finalizationGuardDelayMs: 1_000,
      tracer: trace.getTracer("test", "0.0.0"),
    });
  }

  async function setupParentAndChild(
    engine: RunEngine,
    prisma: any,
    authenticatedEnvironment: any,
    options?: { childTtl?: string; dequeueChild?: boolean }
  ) {
    const parentTask = "parent-task";
    const childTask = "child-task";

    await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, childTask]);

    const parentRun = await engine.trigger(
      {
        number: 1,
        friendlyId: "run_p1234",
        environment: authenticatedEnvironment,
        taskIdentifier: parentTask,
        payload: "{}",
        payloadType: "application/json",
        context: {},
        traceContext: {},
        traceId: "t12345",
        spanId: "s12345",
        queue: `task/${parentTask}`,
        isTest: false,
        tags: [],
        workerQueue: "main",
      },
      prisma
    );

    await setTimeout(500);
    await engine.dequeueFromWorkerQueue({
      consumerId: "test_12345",
      workerQueue: "main",
    });
    const initialExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
    assertNonNullable(initialExecutionData);
    await engine.startRunAttempt({
      runId: parentRun.id,
      snapshotId: initialExecutionData.snapshot.id,
    });

    const childRun = await engine.trigger(
      {
        number: 1,
        friendlyId: "run_c1234",
        environment: authenticatedEnvironment,
        taskIdentifier: childTask,
        payload: "{}",
        payloadType: "application/json",
        context: {},
        traceContext: {},
        traceId: "t12346",
        spanId: "s12346",
        queue: `task/${childTask}`,
        isTest: false,
        tags: [],
        resumeParentOnCompletion: true,
        parentTaskRunId: parentRun.id,
        workerQueue: "main",
        ttl: options?.childTtl,
        enableFastPath: options?.childTtl ? false : undefined,
      },
      prisma
    );

    if (options?.dequeueChild === false) {
      return { parentRun, childRun, childAttempt: undefined };
    }

    await setTimeout(500);
    const dequeuedChild = await engine.dequeueFromWorkerQueue({
      consumerId: "test_12345",
      workerQueue: "main",
    });
    const childAttempt = await engine.startRunAttempt({
      runId: childRun.id,
      snapshotId: dequeuedChild[0].snapshot.id,
    });

    return { parentRun, childRun, childAttempt };
  }

  containerTest(
    "re-derives a waitpoint completion lost after the finish commit",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { parentRun, childRun, childAttempt } = await setupParentAndChild(
          engine,
          prisma,
          authenticatedEnvironment
        );

        vi.spyOn(engine.waitpointSystem, "completeWaitpoint").mockRejectedValueOnce(
          new Error("simulated DB connection loss")
        );

        await expect(
          engine.completeRunAttempt({
            runId: childRun.id,
            snapshotId: childAttempt.snapshot.id,
            completion: {
              id: childRun.id,
              ok: true,
              output: '{"foo":"bar"}',
              outputType: "application/json",
            },
          })
        ).rejects.toThrow("simulated DB connection loss");

        const childAfterFailure = await prisma.taskRun.findFirstOrThrow({
          where: { id: childRun.id },
          include: { associatedWaitpoint: true },
        });
        expect(childAfterFailure.status).toBe("COMPLETED_SUCCESSFULLY");
        expect(childAfterFailure.associatedWaitpoint?.status).toBe("PENDING");

        await setTimeout(5_000);

        const childAfterGuard = await prisma.taskRun.findFirstOrThrow({
          where: { id: childRun.id },
          include: { associatedWaitpoint: true },
        });
        expect(childAfterGuard.associatedWaitpoint?.status).toBe("COMPLETED");

        const parentExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentExecutionData);
        expect(parentExecutionData.snapshot.executionStatus).toBe("EXECUTING");
        expect(parentExecutionData.completedWaitpoints?.length).toBe(1);
        expect(parentExecutionData.completedWaitpoints![0].output).toBe('{"foo":"bar"}');
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "re-runs the unblock fan-out when the continueRunIfUnblocked enqueue was lost",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { parentRun, childRun, childAttempt } = await setupParentAndChild(
          engine,
          prisma,
          authenticatedEnvironment
        );

        const worker = (engine as any).worker;
        const originalEnqueue = worker.enqueue.bind(worker);
        let failedOnce = false;
        const enqueueSpy = vi.spyOn(worker, "enqueue").mockImplementation(async (opts: any) => {
          if (opts.job === "continueRunIfUnblocked" && !failedOnce) {
            failedOnce = true;
            throw new Error("simulated redis enqueue loss");
          }
          return originalEnqueue(opts);
        });

        await expect(
          engine.completeRunAttempt({
            runId: childRun.id,
            snapshotId: childAttempt.snapshot.id,
            completion: {
              id: childRun.id,
              ok: true,
              output: '{"foo":"bar"}',
              outputType: "application/json",
            },
          })
        ).rejects.toThrow("simulated redis enqueue loss");

        const childAfterFailure = await prisma.taskRun.findFirstOrThrow({
          where: { id: childRun.id },
          include: { associatedWaitpoint: true },
        });
        expect(childAfterFailure.status).toBe("COMPLETED_SUCCESSFULLY");
        expect(childAfterFailure.associatedWaitpoint?.status).toBe("COMPLETED");

        await setTimeout(5_000);
        enqueueSpy.mockRestore();

        const parentExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentExecutionData);
        expect(parentExecutionData.snapshot.executionStatus).toBe("EXECUTING");
        expect(parentExecutionData.completedWaitpoints?.length).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a failed guard enqueue fails the completion request with nothing committed",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { parentRun, childRun, childAttempt } = await setupParentAndChild(
          engine,
          prisma,
          authenticatedEnvironment
        );

        const worker = (engine as any).worker;
        const originalEnqueue = worker.enqueue.bind(worker);
        const enqueueSpy = vi.spyOn(worker, "enqueue").mockImplementation(async (opts: any) => {
          if (opts.job === "ensureRunFinalized") {
            throw new Error("simulated redis enqueue failure");
          }
          return originalEnqueue(opts);
        });

        await expect(
          engine.completeRunAttempt({
            runId: childRun.id,
            snapshotId: childAttempt.snapshot.id,
            completion: {
              id: childRun.id,
              ok: true,
              output: '{"foo":"bar"}',
              outputType: "application/json",
            },
          })
        ).rejects.toThrow("simulated redis enqueue failure");

        const childAfterFailure = await prisma.taskRun.findFirstOrThrow({
          where: { id: childRun.id },
          include: { associatedWaitpoint: true },
        });
        expect(childAfterFailure.status).toBe("EXECUTING");
        expect(childAfterFailure.associatedWaitpoint?.status).toBe("PENDING");

        enqueueSpy.mockRestore();

        await engine.completeRunAttempt({
          runId: childRun.id,
          snapshotId: childAttempt.snapshot.id,
          completion: {
            id: childRun.id,
            ok: true,
            output: '{"foo":"bar"}',
            outputType: "application/json",
          },
        });

        await setTimeout(1_000);

        const parentExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentExecutionData);
        expect(parentExecutionData.snapshot.executionStatus).toBe("EXECUTING");
        expect(parentExecutionData.completedWaitpoints?.length).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a stale guard does not resume the parent while a cancellation is still in flight",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { parentRun, childRun, childAttempt } = await setupParentAndChild(
          engine,
          prisma,
          authenticatedEnvironment
        );

        vi.spyOn((engine as any).runStore, "completeAttemptSuccess").mockRejectedValueOnce(
          new Error("simulated finish commit failure")
        );

        await expect(
          engine.completeRunAttempt({
            runId: childRun.id,
            snapshotId: childAttempt.snapshot.id,
            completion: {
              id: childRun.id,
              ok: true,
              output: '{"foo":"bar"}',
              outputType: "application/json",
            },
          })
        ).rejects.toThrow("simulated finish commit failure");

        await engine.cancelRun({ runId: childRun.id });

        const childAfterCancel = await prisma.taskRun.findFirstOrThrow({
          where: { id: childRun.id },
          include: { associatedWaitpoint: true },
        });
        expect(childAfterCancel.status).toBe("CANCELED");

        await setTimeout(5_000);

        const childDuringPendingCancel = await prisma.taskRun.findFirstOrThrow({
          where: { id: childRun.id },
          include: { associatedWaitpoint: true },
        });
        expect(childDuringPendingCancel.associatedWaitpoint?.status).toBe("PENDING");

        const parentWhilePending = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentWhilePending);
        expect(parentWhilePending.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        await engine.cancelRun({ runId: childRun.id, finalizeRun: true });

        await setTimeout(1_000);

        const childAfterFinalize = await prisma.taskRun.findFirstOrThrow({
          where: { id: childRun.id },
          include: { associatedWaitpoint: true },
        });
        expect(childAfterFinalize.associatedWaitpoint?.status).toBe("COMPLETED");

        const parentAfterFinalize = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentAfterFinalize);
        expect(parentAfterFinalize.snapshot.executionStatus).toBe("EXECUTING");
        expect(parentAfterFinalize.completedWaitpoints?.length).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "an exhausted deferral budget delivers even while cancellation looks in flight",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { parentRun, childRun, childAttempt } = await setupParentAndChild(
          engine,
          prisma,
          authenticatedEnvironment
        );

        vi.spyOn((engine as any).runStore, "completeAttemptSuccess").mockRejectedValueOnce(
          new Error("simulated finish commit failure")
        );

        await expect(
          engine.completeRunAttempt({
            runId: childRun.id,
            snapshotId: childAttempt.snapshot.id,
            completion: {
              id: childRun.id,
              ok: true,
              output: '{"foo":"bar"}',
              outputType: "application/json",
            },
          })
        ).rejects.toThrow("simulated finish commit failure");

        await engine.cancelRun({ runId: childRun.id });

        await engine.runAttemptSystem.ensureRunFinalized({ runId: childRun.id, deferCount: 3 });

        const childWithinBudget = await prisma.taskRun.findFirstOrThrow({
          where: { id: childRun.id },
          include: { associatedWaitpoint: true },
        });
        expect(childWithinBudget.associatedWaitpoint?.status).toBe("PENDING");

        await engine.runAttemptSystem.ensureRunFinalized({ runId: childRun.id, deferCount: 10 });

        const childAfterBudget = await prisma.taskRun.findFirstOrThrow({
          where: { id: childRun.id },
          include: { associatedWaitpoint: true },
        });
        expect(childAfterBudget.associatedWaitpoint?.status).toBe("COMPLETED");
        expect(childAfterBudget.associatedWaitpoint?.outputIsError).toBe(true);

        await setTimeout(1_000);

        const parentExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentExecutionData);
        expect(parentExecutionData.snapshot.executionStatus).toBe("EXECUTING");
        expect(parentExecutionData.completedWaitpoints?.length).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "re-derives a cancellation lost after the CANCELED commit on a queued child",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { parentRun, childRun } = await setupParentAndChild(
          engine,
          prisma,
          authenticatedEnvironment,
          { dequeueChild: false }
        );

        vi.spyOn((engine as any).runQueue, "acknowledgeMessage").mockRejectedValueOnce(
          new Error("simulated redis loss")
        );

        await expect(engine.cancelRun({ runId: childRun.id })).rejects.toThrow(
          "simulated redis loss"
        );

        const childAfterCrash = await prisma.taskRun.findFirstOrThrow({
          where: { id: childRun.id },
          include: { associatedWaitpoint: true },
        });
        expect(childAfterCrash.status).toBe("CANCELED");
        expect(childAfterCrash.associatedWaitpoint?.status).toBe("PENDING");

        await setTimeout(5_000);

        const childAfterGuard = await prisma.taskRun.findFirstOrThrow({
          where: { id: childRun.id },
          include: { associatedWaitpoint: true },
        });
        expect(childAfterGuard.associatedWaitpoint?.status).toBe("COMPLETED");
        expect(childAfterGuard.associatedWaitpoint?.outputIsError).toBe(true);

        const parentExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentExecutionData);
        expect(parentExecutionData.snapshot.executionStatus).toBe("EXECUTING");
        expect(parentExecutionData.completedWaitpoints?.length).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "re-derives a waitpoint completion lost during TTL expiry",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { parentRun, childRun } = await setupParentAndChild(
          engine,
          prisma,
          authenticatedEnvironment,
          { childTtl: "1s", dequeueChild: false }
        );

        vi.spyOn(engine.waitpointSystem, "completeWaitpoint").mockRejectedValueOnce(
          new Error("simulated DB connection loss")
        );

        await expect(engine.ttlSystem.expireRun({ runId: childRun.id })).rejects.toThrow(
          "simulated DB connection loss"
        );

        const childAfterFailure = await prisma.taskRun.findFirstOrThrow({
          where: { id: childRun.id },
          include: { associatedWaitpoint: true },
        });
        expect(childAfterFailure.status).toBe("EXPIRED");
        expect(childAfterFailure.associatedWaitpoint?.status).toBe("PENDING");

        await setTimeout(5_000);

        const childAfterGuard = await prisma.taskRun.findFirstOrThrow({
          where: { id: childRun.id },
          include: { associatedWaitpoint: true },
        });
        expect(childAfterGuard.status).toBe("EXPIRED");
        expect(childAfterGuard.associatedWaitpoint?.status).toBe("COMPLETED");
        expect(childAfterGuard.associatedWaitpoint?.outputIsError).toBe(true);

        const parentExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentExecutionData);
        expect(parentExecutionData.snapshot.executionStatus).toBe("EXECUTING");
        expect(parentExecutionData.completedWaitpoints?.length).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "guard is acked on the happy path and never executes",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { parentRun, childRun, childAttempt } = await setupParentAndChild(
          engine,
          prisma,
          authenticatedEnvironment
        );

        const guardSpy = vi.spyOn(engine.runAttemptSystem, "ensureRunFinalized");

        await engine.completeRunAttempt({
          runId: childRun.id,
          snapshotId: childAttempt.snapshot.id,
          completion: {
            id: childRun.id,
            ok: true,
            output: '{"foo":"bar"}',
            outputType: "application/json",
          },
        });

        await setTimeout(4_000);

        expect(guardSpy).not.toHaveBeenCalled();

        const parentExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentExecutionData);
        expect(parentExecutionData.snapshot.executionStatus).toBe("EXECUTING");
        expect(parentExecutionData.completedWaitpoints?.length).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );
});
