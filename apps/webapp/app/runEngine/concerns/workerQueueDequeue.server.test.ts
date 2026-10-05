import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import type { WorkerQueueSubscription } from "@trigger.dev/core/v3/workers";
import { expect } from "vitest";
import { dequeueWorkerQueues } from "~/runEngine/concerns/workerQueueDequeue.server";
import { createWorkerQueueConsumer } from "~/runEngine/concerns/workerQueueSubscriptions.server";

containerTest(
  "authorizes the entire subscription set before pop and retains legacy dequeue",
  async ({ prisma, redisOptions }) => {
    const engine = new RunEngine({
      prisma,
      worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
      queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
      runLock: { redis: redisOptions },
      machines: {
        defaultMachine: "small-1x",
        machines: {
          "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
        },
        baseCostInCents: 0.0005,
      },
      tracer: trace.getTracer("multi-queue-test"),
    });

    try {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);
      const stable: WorkerQueueSubscription = {
        class: "ondemand",
        phase: "fresh",
        compat: "container",
        channel: "stable",
      };
      const canary: WorkerQueueSubscription = { ...stable, channel: "canary" };
      const scheduled: WorkerQueueSubscription = { ...stable, class: "scheduled" };
      const worker = createWorkerQueueConsumer({
        workerGroupId: environment.project.defaultWorkerGroupId!,
        workerInstanceId: "test-instance",
        masterQueue: "legacy-region",
        region: "us-east-1",
        workloadType: "CONTAINER" as const,
        allowedSubscriptions: [stable, scheduled],
      });

      const lanes = [
        "us-east-1:v2:ondemand:fresh:container:stable",
        "us-east-1:v2:scheduled:fresh:container:stable",
        "legacy-region",
        "legacy-region:scheduled",
      ];
      const runs = [];
      for (const [index, workerQueue] of lanes.entries()) {
        runs.push(
          await engine.trigger(
            {
              number: index + 1,
              friendlyId: generateFriendlyId("run"),
              environment,
              taskIdentifier,
              payload: "{}",
              payloadType: "application/json",
              context: {},
              traceContext: {},
              traceId: "test-trace",
              spanId: "test-span",
              workerQueue,
              enableFastPath: true,
              queue: `task/${taskIdentifier}`,
              isTest: false,
              tags: [],
            },
            prisma
          )
        );
      }

      expect(() =>
        dequeueWorkerQueues({ engine, worker, subscriptions: [stable, canary] })
      ).toThrow("not authorized");
      const unchanged = await engine.getRunExecutionData({ runId: runs[0]!.id });
      expect(unchanged?.snapshot.executionStatus).toBe("QUEUED");

      const deliveredRunIds = new Set<string>();
      for (const remaining of [1, 0]) {
        const delivery = await dequeueWorkerQueues({
          engine,
          worker,
          subscriptions: [stable, scheduled],
        });
        expect(delivery).toHaveLength(1);
        assertNonNullable(delivery[0]);
        deliveredRunIds.add(delivery[0].run.id);
        expect(delivery[0].snapshot.executionStatus).toBe("PENDING_EXECUTING");
        expect(delivery[0].workerQueueLength).toBe(remaining);
      }
      expect(deliveredRunIds).toEqual(new Set([runs[0]!.id, runs[1]!.id]));

      expect((await dequeueWorkerQueues({ engine, worker }))[0]?.run.id).toBe(runs[2]!.id);
      expect(
        (await dequeueWorkerQueues({ engine, worker, queueClass: "scheduled" }))[0]?.run.id
      ).toBe(runs[3]!.id);
    } finally {
      await engine.quit();
    }
  }
);
