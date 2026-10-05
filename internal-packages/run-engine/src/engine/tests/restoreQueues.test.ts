import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { createTestSnapshot } from "./helpers/snapshotTestHelpers.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

for (const scenario of [
  {
    checkpointType: "KUBERNETES",
    birthQueue: "us-east-1:v2:scheduled:fresh:any:canary",
    restoreQueue: "us-east-1:v2:scheduled:restore:container:canary",
    wrongQueue: "us-east-1:v2:scheduled:restore:compute:canary",
    enableFastPath: true,
    queuedExecuting: false,
  },
  {
    checkpointType: "COMPUTE",
    birthQueue: "us-east-1:v2:scheduled:fresh:any:stable",
    restoreQueue: "us-east-1:v2:scheduled:restore:compute:stable",
    wrongQueue: "us-east-1:v2:scheduled:restore:container:stable",
    enableFastPath: false,
    queuedExecuting: true,
  },
] as const) {
  containerTest(
    `${scenario.checkpointType} restore and real retry preserve runtime, channel and checkpoint`,
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine({
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
          retryOptions: { maxAttempts: 5, minTimeoutInMs: 1, maxTimeoutInMs: 1, factor: 1 },
        },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": {
              name: "small-1x",
              cpu: 0.5,
              memory: 0.5,
              centsPerMs: 0.0001,
            },
          },
          baseCostInCents: 0.0005,
        },
        retryWarmStartThresholdMs: 0,
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const dequeue = (workerQueue: string) =>
        engine.dequeueFromWorkerQueue({
          consumerId: "restore-test",
          workerQueue,
          blockingPop: false,
        });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);
        const batch = await prisma.batchTaskRun.create({
          data: {
            friendlyId: generateFriendlyId("batch"),
            runtimeEnvironmentId: environment.id,
          },
        });
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: generateFriendlyId("run"),
            environment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "restore-trace",
            spanId: "restore-span",
            workerQueue: scenario.birthQueue,
            enableFastPath: scenario.enableFastPath,
            queue: `task/${taskIdentifier}`,
            concurrencyKey: "shared-admission",
            isTest: false,
            tags: [],
          },
          prisma
        );

        await engine.runQueue.processMasterQueueForEnvironment(environment.id, 10);
        const [initial] = await dequeue(scenario.birthQueue);
        assertNonNullable(initial);
        expect(initial.run.id).toBe(run.id);
        expect(initial.checkpoint).toBeUndefined();
        const started = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: initial.snapshot.id,
        });

        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: environment.id,
          projectId: environment.project.id,
        });
        const blocked = await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.id,
          projectId: environment.project.id,
          organizationId: environment.organization.id,
        });
        if (scenario.queuedExecuting) {
          await engine.executionSnapshotSystem.createExecutionSnapshot(prisma, {
            run: started.run,
            snapshot: {
              executionStatus: "QUEUED_EXECUTING",
              description: "Checkpoint request is in flight during re-enqueue",
            },
            previousSnapshotId: blocked.id,
            environmentId: environment.id,
            environmentType: environment.type,
            projectId: environment.project.id,
            organizationId: environment.organization.id,
          });
        }

        const accepted = await engine.createCheckpoint({
          runId: run.id,
          snapshotId: blocked.id,
          checkpoint: {
            type: scenario.checkpointType,
            reason: "TEST_RESTORE_QUEUE",
            location: "test-checkpoint",
            imageRef: "test-image",
          },
        });
        expect(accepted.ok).toBe(true);
        if (!accepted.ok) throw new Error(accepted.error);
        const checkpointId = accepted.checkpoint.id;

        await prisma.organization.update({
          where: { id: environment.organization.id },
          data: {
            featureFlags: {
              workerQueueV2Enabled: false,
              workerQueueChannel: "stable",
              workerQueueCompatibility: "compute",
            },
          },
        });
        await engine.completeWaitpoint({ id: waitpoint.id });
        await engine.waitpointSystem.continueRunIfUnblocked({ runId: run.id });
        await engine.runQueue.processMasterQueueForEnvironment(environment.id, 10);

        const message = await engine.runQueue.readMessage(environment.organization.id, run.id);
        assertNonNullable(message);
        expect(message.workerQueue).toBe(scenario.restoreQueue);
        expect(message.concurrencyKey).toBe("shared-admission");
        expect(await dequeue(scenario.birthQueue)).toEqual([]);
        expect(await dequeue(scenario.wrongQueue)).toEqual([]);

        const beforeRecovery = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(beforeRecovery);
        await prisma.taskRunExecutionSnapshot.update({
          where: { id: beforeRecovery.snapshot.id },
          data: { batchId: batch.id },
        });
        if (scenario.checkpointType === "COMPUTE") {
          const snapshotCount = await prisma.taskRunExecutionSnapshot.count({
            where: { runId: run.id },
          });
          await prisma.taskRunExecutionSnapshot.updateMany({
            where: { runId: run.id },
            data: { isValid: false },
          });
          expect(await dequeue(scenario.restoreQueue)).toEqual([]);
          expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(
            snapshotCount
          );
          await prisma.taskRunExecutionSnapshot.update({
            where: { id: beforeRecovery.snapshot.id },
            data: { isValid: true },
          });
          await expect
            .poll(async () => {
              await engine.runQueue.processMasterQueueForEnvironment(environment.id, 10);
              return (await engine.runQueue.peekAllOnWorkerQueue(scenario.restoreQueue)).length;
            })
            .toBe(1);
        }

        engine.eventBus.once("runLocked", () => {
          throw new Error("Restore preparation failed after locking the run");
        });
        expect(await dequeue(scenario.restoreQueue)).toEqual([]);
        const recovered = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(recovered);
        expect(recovered.snapshot.executionStatus).toBe("QUEUED");
        expect(recovered.checkpoint?.id).toBe(checkpointId);
        expect(recovered.completedWaitpoints).toEqual(beforeRecovery.completedWaitpoints);
        expect(recovered.batch?.id).toBe(batch.id);

        let firstRestore: Awaited<ReturnType<typeof dequeue>>[number] | undefined;
        await expect
          .poll(async () => {
            await engine.runQueue.processMasterQueueForEnvironment(environment.id, 10);
            [firstRestore] = await dequeue(scenario.restoreQueue);
            return firstRestore?.run.id;
          })
          .toBe(run.id);
        assertNonNullable(firstRestore);
        expect(firstRestore.run.id).toBe(run.id);
        expect(firstRestore.checkpoint?.id).toBe(checkpointId);
        expect(firstRestore.checkpoint?.type).toBe(scenario.checkpointType);

        const retried = await engine.runAttemptSystem.tryNackAndRequeue({
          run: { id: run.id },
          environment,
          orgId: environment.organization.id,
          projectId: environment.project.id,
          timestamp: Date.now(),
          checkpointId,
          snapshotRoute: firstRestore.snapshotRoute,
          error: {
            type: "INTERNAL_ERROR",
            code: "TASK_RUN_DEQUEUED_MAX_RETRIES",
            message: "Retry restore delivery",
          },
        });
        expect(retried.wasRequeued).toBe(true);
        const retryMessage = await engine.runQueue.readMessage(environment.organization.id, run.id);
        assertNonNullable(retryMessage);
        expect(retryMessage.workerQueue).toBe(scenario.restoreQueue);
        expect(retryMessage.queue).toBe(message.queue);
        expect(retryMessage.concurrencyKey).toBe(message.concurrencyKey);
        expect(retryMessage.snapshotRoute).toEqual(message.snapshotRoute);

        await engine.runQueue.processMasterQueueForEnvironment(environment.id, 10);
        const [secondRestore] = await dequeue(scenario.restoreQueue);
        assertNonNullable(secondRestore);
        expect(secondRestore.run.id).toBe(run.id);
        expect(secondRestore.checkpoint?.id).toBe(checkpointId);
        expect(secondRestore.checkpoint?.type).toBe(scenario.checkpointType);
        expect(await dequeue(scenario.restoreQueue)).toEqual([]);
        expect(await dequeue(scenario.birthQueue)).toEqual([]);
        expect(await dequeue(scenario.wrongQueue)).toEqual([]);

        const storedRun = await prisma.taskRun.findFirst({ where: { id: run.id } });
        expect(storedRun?.workerQueue).toBe(scenario.birthQueue);
        const continued = await engine.continueRunExecution({
          runId: run.id,
          snapshotId: secondRestore.snapshot.id,
        });
        expect(continued.snapshot.executionStatus).toBe("EXECUTING");

        if (scenario.checkpointType === "COMPUTE") {
          const failed = await engine.completeRunAttempt({
            runId: run.id,
            snapshotId: continued.snapshot.id,
            completion: {
              ok: false,
              id: run.id,
              error: {
                type: "BUILT_IN_ERROR",
                name: "Error",
                message: "Retry the restored attempt from scratch",
                stackTrace: "",
              },
              retry: { timestamp: Date.now(), delay: 0 },
            },
          });
          expect(failed.attemptStatus).toBe("RETRY_QUEUED");

          const freshMessage = await engine.runQueue.readMessage(
            environment.organization.id,
            run.id
          );
          assertNonNullable(freshMessage);
          expect(freshMessage.workerQueue).toBe(scenario.birthQueue);
          expect(freshMessage.queue).toBe(message.queue);
          expect(freshMessage.concurrencyKey).toBe(message.concurrencyKey);
          expect(freshMessage.snapshotRoute).toEqual(message.snapshotRoute);

          await engine.runQueue.processMasterQueueForEnvironment(environment.id, 10);
          expect(await dequeue(scenario.restoreQueue)).toEqual([]);
          const [freshAttempt] = await dequeue(scenario.birthQueue);
          assertNonNullable(freshAttempt);
          expect(freshAttempt.run.id).toBe(run.id);
          expect(freshAttempt.checkpoint).toBeUndefined();
          expect(await dequeue(scenario.birthQueue)).toEqual([]);
        }
      } finally {
        await engine.quit();
      }
    }
  );
}

containerTest(
  "dequeue recovery does not requeue a run whose preparation already resumed execution",
  async ({ prisma, redisOptions }) => {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const engine = new RunEngine({
      prisma,
      worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
      queue: {
        redis: redisOptions,
        masterQueueConsumersDisabled: true,
        processWorkerQueueDebounceMs: 50,
      },
      runLock: { redis: redisOptions },
      machines: {
        defaultMachine: "small-1x",
        machines: {
          "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
        },
        baseCostInCents: 0.0001,
      },
      tracer: trace.getTracer("test", "0.0.0"),
    });

    try {
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);
      const friendlyId = generateFriendlyId("run");
      const run = await engine.trigger(
        {
          number: 1,
          friendlyId,
          environment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: friendlyId,
          spanId: friendlyId,
          workerQueue: "main",
          queue: `task/${taskIdentifier}`,
          isTest: false,
          tags: [],
        },
        prisma
      );

      const queued = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(queued);
      await createTestSnapshot(prisma, {
        runId: run.id,
        status: "QUEUED_EXECUTING",
        environmentId: environment.id,
        environmentType: "PRODUCTION",
        projectId: environment.projectId,
        organizationId: environment.organizationId,
        previousSnapshotId: queued.snapshot.id,
        attemptNumber: 1,
      });

      await engine.runQueue.processMasterQueueForEnvironment(environment.id, 5);
      engine.eventBus.once("workerNotification", () => {
        throw new Error("Failed after the EXECUTING snapshot committed");
      });
      expect(
        await engine.dequeueFromWorkerQueue({
          consumerId: "recovery-test",
          workerQueue: "main",
          blockingPop: false,
        })
      ).toEqual([]);

      const after = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(after);
      expect(after.snapshot.executionStatus).toBe("EXECUTING");
      expect(
        await engine.runQueue.readMessage(environment.organization.id, run.id)
      ).toBeUndefined();
    } finally {
      await engine.quit();
    }
  }
);
