import { assertNonNullable, redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Decimal } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { describe, expect } from "vitest";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";

const stable = "us-east-1:v2:ondemand:fresh:container:stable";
const canary = "us-east-1:v2:ondemand:fresh:container:canary";
const empty = "us-east-1:v2:scheduled:fresh:container:stable";
const excluded = "us-east-1:v2:ondemand:restore:compute:stable";

const select = (queue: string, weight = 1) => ({ queue, weight });
const environment = {
  id: "env-test",
  type: "PRODUCTION" as const,
  maximumConcurrencyLimit: 20,
  concurrencyLimitBurstFactor: new Decimal(1),
  project: { id: "project-test" },
  organization: { id: "org-test" },
};

function createQueue(redis: { host: string; port: number }) {
  const keys = new RunQueueFullKeyProducer();
  const options = { ...redis, keyPrefix: "multi-queue:" };
  return new RunQueue({
    name: "multi-queue",
    tracer: trace.getTracer("multi-queue"),
    workers: 1,
    defaultEnvConcurrency: 20,
    masterQueueConsumersDisabled: true,
    redis: options,
    keys,
    queueSelectionStrategy: new FairQueueSelectionStrategy({ redis: options, keys }),
  });
}

async function enqueue(queue: RunQueue, runId: string, workerQueue: string) {
  await queue.enqueueMessage({
    env: environment,
    workerQueue,
    enableFastPath: true,
    message: {
      runId,
      orgId: environment.organization.id,
      projectId: environment.project.id,
      environmentId: environment.id,
      environmentType: environment.type,
      queue: "task/test",
      timestamp: Date.now(),
      attempt: 0,
    },
  });
}

describe.each([false, true])("multi-queue dequeue, blocking=%s", (blockingPop) => {
  redisTest(
    "pops one subscribed message and reports combined backlog",
    async ({ redisOptions }) => {
      const queue = createQueue(redisOptions);
      try {
        await queue.updateEnvConcurrencyLimits(environment);
        await enqueue(queue, "stable-1", stable);
        await enqueue(queue, "stable-2", stable);
        await enqueue(queue, "canary-1", canary);
        await enqueue(queue, "canary-2", canary);
        await enqueue(queue, "excluded-1", excluded);

        const runIds = new Set<string>();
        for (let remaining = 3; remaining >= 0; remaining--) {
          const message = await queue.dequeueMessageFromWorkerQueues(
            "consumer",
            [select(empty), select(stable), select(canary), select(stable), select(excluded, 0)],
            { blockingPop, blockingPopTimeoutSeconds: 0.1 }
          );
          assertNonNullable(message);
          expect([stable, canary]).toContain(message.workerQueue);
          expect(message.workerQueueLength).toBe(remaining);
          expect(message.selectedWorkerQueueLength).toBe(
            (await queue.peekAllOnWorkerQueue(message.workerQueue)).length
          );
          if (remaining === 3) {
            expect(message.selectedWorkerQueueLength).toBe(1);
          }
          runIds.add(message.messageId);
        }
        expect(runIds).toEqual(new Set(["stable-1", "stable-2", "canary-1", "canary-2"]));
        expect(
          await queue.dequeueMessageFromWorkerQueues(
            "consumer",
            [select(stable), select(canary), select(excluded, 0)],
            {
              blockingPop,
              blockingPopTimeoutSeconds: 0.1,
            }
          )
        ).toBeUndefined();

        const untouched = await queue.dequeueMessageFromWorkerQueue("consumer", excluded, {
          blockingPop: false,
        });
        expect(untouched?.messageId).toBe("excluded-1");
      } finally {
        await queue.quit();
      }
    }
  );
});

redisTest(
  "a blocking subscription wakes when work arrives on any lane",
  async ({ redisOptions }) => {
    const queue = createQueue(redisOptions);
    try {
      await queue.updateEnvConcurrencyLimits(environment);
      const delivery = queue.dequeueMessageFromWorkerQueues(
        "consumer",
        [select(empty), select(canary)],
        {
          blockingPopTimeoutSeconds: 2,
        }
      );
      await setTimeout(50);
      await enqueue(queue, "late-canary", canary);
      expect((await delivery)?.messageId).toBe("late-canary");
    } finally {
      await queue.quit();
    }
  }
);
