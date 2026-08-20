import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { Decimal } from "@trigger.dev/database";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 25,
  logger: new Logger("RunQueue", "warn"),
  retryOptions: {
    maxAttempts: 5,
    factor: 1.1,
    minTimeoutInMs: 100,
    maxTimeoutInMs: 1_000,
    randomize: true,
  },
  keys: new RunQueueFullKeyProducer(),
};

const authenticatedEnvDev = {
  id: "e1234",
  type: "DEVELOPMENT" as const,
  maximumConcurrencyLimit: 10,
  concurrencyLimitBurstFactor: new Decimal(2.0),
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

function createQueue(redisContainer: any) {
  return new RunQueue({
    ...testOptions,
    masterQueueConsumersDisabled: true,
    workerOptions: { disabled: true },
    queueSelectionStrategy: new FairQueueSelectionStrategy({
      redis: {
        keyPrefix: "runqueue:test:",
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      },
      keys: testOptions.keys,
    }),
    redis: {
      keyPrefix: "runqueue:test:",
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
    },
  });
}

function makeMessage(overrides: Partial<InputPayload> = {}): InputPayload {
  return {
    runId: "r1",
    taskIdentifier: "task/my-task",
    orgId: "o1234",
    projectId: "p1234",
    environmentId: "e1234",
    environmentType: "DEVELOPMENT",
    queue: "task/my-task",
    timestamp: Date.now(),
    attempt: 0,
    ...overrides,
  };
}

const QUEUE = "task/my-task";

vi.setConfig({ testTimeout: 60_000 });

// A concurrency key is an unrestricted client string, so `*` is reachable from the public
// API, and `queueKey` renders it as `...:queue:<q>:ck:*`, which is byte-identical to the
// wildcard member the CK scripts keep in the master queue. Each of those scripts rebalances
// the master queue with that wildcard member and then removes the "old-format" entry for the
// variant it just touched. When the variant IS the wildcard, the second call undid the
// first, taking the whole base queue's master-queue entry with it: nothing pointed at the
// queue any more, so every concurrency key on it stopped being dequeued, silently, until
// some later write happened to re-add the member.
describe("concurrency key of '*'", () => {
  redisTest("enqueueing it leaves the base queue reachable", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      const t0 = Date.now() - 100_000;
      const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
      const masterQueueKey = testOptions.keys.masterQueueKeyForShard(shard);

      // An ordinary key with real queued work: the bystander that used to be taken down.
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r-victim", concurrencyKey: "user-1", timestamp: t0 }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });
      expect(await queue.redis.zcard(masterQueueKey)).toBe(1);

      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r-star", concurrencyKey: "*", timestamp: t0 + 1 }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });

      // The master queue still points at this base queue.
      expect(await queue.redis.zcard(masterQueueKey)).toBe(1);

      // Both variants are registered, and both runs come back out.
      const ckIndexKey = testOptions.keys.ckIndexKeyFromQueue(
        testOptions.keys.queueKey(authenticatedEnvDev, QUEUE, "user-1")
      );
      expect((await queue.redis.zrange(ckIndexKey, 0, -1)).length).toBe(2);

      const served = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 10);
      expect(served.map((m) => m.messageId).sort()).toEqual(["r-star", "r-victim"]);
    } finally {
      await queue.quit();
    }
  });

  redisTest("acking it leaves the base queue reachable", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      const t0 = Date.now() - 100_000;
      const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
      const masterQueueKey = testOptions.keys.masterQueueKeyForShard(shard);

      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r-star", concurrencyKey: "*", timestamp: t0 }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r-victim", concurrencyKey: "user-1", timestamp: t0 + 1 }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });

      // Ack the '*' run while the other key still has work queued: the ack script runs the
      // same rebalance-then-cleanup pair as the enqueue one.
      await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, "r-star", {
        skipDequeueProcessing: true,
      });

      expect(await queue.redis.zcard(masterQueueKey)).toBe(1);

      const served = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 10);
      expect(served.map((m) => m.messageId)).toEqual(["r-victim"]);
    } finally {
      await queue.quit();
    }
  });

  redisTest("nacking it leaves the base queue reachable", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      const t0 = Date.now() - 100_000;
      const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
      const masterQueueKey = testOptions.keys.masterQueueKeyForShard(shard);

      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r-star", concurrencyKey: "*", timestamp: t0 }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });

      const [dequeued] = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 1);
      expect(dequeued?.messageId).toBe("r-star");

      await queue.nackMessage({
        orgId: authenticatedEnvDev.organization.id,
        messageId: "r-star",
        retryAt: Date.now() - 1,
        skipDequeueProcessing: true,
      });

      expect(await queue.redis.zcard(masterQueueKey)).toBe(1);

      const served = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 1);
      expect(served.map((m) => m.messageId)).toEqual(["r-star"]);
    } finally {
      await queue.quit();
    }
  });
});
