import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import {
  assertNonNullable,
  containerTest,
  containerTestWithIsolatedRedis,
} from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import type { DequeuedMessage } from "@trigger.dev/core/v3";
import type { WorkerQueueSubscription } from "@trigger.dev/core/v3/workers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RedisOptions } from "ioredis";
import { expect, vi } from "vitest";
import { dequeueWorkerQueues } from "~/runEngine/concerns/workerQueueDequeue.server";
import { createWorkerQueueConsumer } from "~/runEngine/concerns/workerQueueSubscriptions.server";

vi.setConfig({ testTimeout: 30_000 });

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

type Environment = Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>;

const lane = (
  compat: WorkerQueueSubscription["compat"],
  channel: WorkerQueueSubscription["channel"]
): WorkerQueueSubscription => ({ class: "ondemand", phase: "fresh", compat, channel });
const containerStable = lane("container", "stable");
const computeCanary = lane("compute", "canary");
const anyCanary = lane("any", "canary");
const CONTAINER_QUEUE = "us-east-1:v2:ondemand:fresh:container:stable";
const COMPUTE_QUEUE = "us-east-1:v2:ondemand:fresh:compute:canary";
const ANY_QUEUE = "us-east-1:v2:ondemand:fresh:any:canary";

function mixedEngine(prisma: PrismaClient, redisOptions: RedisOptions) {
  return new RunEngine({
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
      dequeueBlockingTimeoutSeconds: 1,
    },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("mixed-group-test"),
  });
}

function mixedGroup(
  environment: Environment,
  workloadType: "CONTAINER" | "MICROVM",
  workerInstanceId: string
) {
  const masterQueue = workloadType === "MICROVM" ? "us-east-1-next" : "us-east-1";
  return {
    worker: createWorkerQueueConsumer({
      workerGroupId: environment.project.defaultWorkerGroupId!,
      workerInstanceId,
      masterQueue,
      region: "us-east-1",
      workloadType,
      allowedSubscriptions: [containerStable, computeCanary, anyCanary],
      mixedRuntime: true,
    }),
    // The group is the region's only group.
    workerGroups: () => [
      {
        id: environment.project.defaultWorkerGroupId!,
        masterQueue,
        region: "us-east-1",
        workloadType,
        hidden: false,
        enableFastPath: false,
        type: "MANAGED" as const,
        projectId: null,
      },
    ],
  };
}

let runNumber = 0;
function triggerOn(
  engine: RunEngine,
  prisma: PrismaClient,
  environment: Environment,
  workerQueue: string
) {
  return engine.trigger(
    {
      number: ++runNumber,
      friendlyId: generateFriendlyId("run"),
      environment,
      taskIdentifier: "test-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "test-trace",
      spanId: "test-span",
      workerQueue,
      queue: "task/test-task",
      isTest: false,
      tags: [],
    },
    prisma
  );
}

async function untilDelivered(dequeue: () => Promise<DequeuedMessage[]>, runId: string) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const [message] = await dequeue();
    if (message) {
      expect(message.run.id).toBe(runId);
      return message;
    }
  }
  expect.fail(`run ${runId} was never delivered`);
}

async function untilMoved(
  prisma: PrismaClient,
  dequeue: () => Promise<DequeuedMessage[]>,
  runId: string,
  workerQueue: string
) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    expect(await dequeue()).toHaveLength(0);
    const run = await prisma.taskRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.workerQueue === workerQueue) return;
  }
  expect.fail(`run ${runId} never moved to ${workerQueue}`);
}

for (const workloadType of ["CONTAINER", "MICROVM"] as const) {
  containerTestWithIsolatedRedis(
    `moves a keyless run off the compute lane of a mixed ${workloadType} group`,
    async ({ prisma, redisOptions }) => {
      const engine = mixedEngine(prisma, redisOptions);
      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        // The default deployment has no template key.
        await setupBackgroundWorker(engine, environment, "test-task");
        const { worker, workerGroups } = mixedGroup(environment, workloadType, "compute-cell");

        const run = await triggerOn(engine, prisma, environment, COMPUTE_QUEUE);
        await untilMoved(
          prisma,
          () =>
            dequeueWorkerQueues({ engine, worker, subscriptions: [computeCanary], workerGroups }),
          run.id,
          CONTAINER_QUEUE
        );

        const delivered = await untilDelivered(
          () =>
            dequeueWorkerQueues({ engine, worker, subscriptions: [containerStable], workerGroups }),
          run.id
        );
        expect(delivered.snapshot.executionStatus).toBe("PENDING_EXECUTING");
      } finally {
        await engine.quit();
      }
    }
  );
}

containerTestWithIsolatedRedis(
  "lets either runtime take an any item in a mixed group, with the template fallback on compute",
  async ({ prisma, redisOptions }) => {
    const engine = mixedEngine(prisma, redisOptions);
    try {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { deployment } = await setupBackgroundWorker(engine, environment, "test-task");
      assertNonNullable(deployment);
      const { worker, workerGroups } = mixedGroup(environment, "MICROVM", "mixed-cell");
      const compute = () =>
        dequeueWorkerQueues({
          engine,
          worker,
          subscriptions: [computeCanary, anyCanary],
          workerGroups,
        });
      const container = () =>
        dequeueWorkerQueues({
          engine,
          worker,
          subscriptions: [containerStable, anyCanary],
          workerGroups,
        });

      // A keyless deployment: a container consumer starts the item, a compute one moves it.
      const toContainer = await triggerOn(engine, prisma, environment, ANY_QUEUE);
      await untilDelivered(container, toContainer.id);
      const keyless = await triggerOn(engine, prisma, environment, ANY_QUEUE);
      await untilMoved(prisma, compute, keyless.id, CONTAINER_QUEUE);
      await untilDelivered(container, keyless.id);

      // A keyed deployment: whichever consumer asks first starts the item.
      await prisma.workerDeployment.update({
        where: { id: deployment.id },
        data: { templateKey: "a".repeat(64) },
      });
      for (const dequeue of [compute, container]) {
        const keyed = await triggerOn(engine, prisma, environment, ANY_QUEUE);
        const delivered = await untilDelivered(dequeue, keyed.id);
        expect(delivered.run.masterQueue).toBe(ANY_QUEUE);
        expect(delivered.snapshot.executionStatus).toBe("PENDING_EXECUTING");
      }
    } finally {
      await engine.quit();
    }
  }
);
