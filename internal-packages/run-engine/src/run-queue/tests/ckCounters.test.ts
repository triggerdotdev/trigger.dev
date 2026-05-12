import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { describe } from "vitest";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import { InputPayload } from "../types.js";
import { Decimal } from "@trigger.dev/database";

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

vi.setConfig({ testTimeout: 60_000 });

describe("CK base-queue counters", () => {
  redisTest(
    "lengthOfQueue returns aggregate across CK variants",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const now = Date.now();
        const messages = [
          makeMessage({ runId: "r1", concurrencyKey: "ck-a", timestamp: now }),
          makeMessage({ runId: "r2", concurrencyKey: "ck-a", timestamp: now + 1 }),
          makeMessage({ runId: "r3", concurrencyKey: "ck-b", timestamp: now + 2 }),
          makeMessage({ runId: "r4", concurrencyKey: "ck-c", timestamp: now + 3 }),
        ];

        for (const msg of messages) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: msg,
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        // Aggregate (no CK arg) should sum all variants
        expect(await queue.lengthOfQueue(authenticatedEnvDev, messages[0].queue)).toBe(4);

        // Per-variant still works
        expect(
          await queue.lengthOfQueue(authenticatedEnvDev, messages[0].queue, "ck-a")
        ).toBe(2);
        expect(
          await queue.lengthOfQueue(authenticatedEnvDev, messages[0].queue, "ck-b")
        ).toBe(1);

        // Plural lengthOfQueues should also see the aggregate
        const lengths = await queue.lengthOfQueues(authenticatedEnvDev, [messages[0].queue]);
        expect(lengths[messages[0].queue]).toBe(4);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "lazy init from pre-existing CK backlog",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const now = Date.now();
        const baseMsg = makeMessage({ runId: "seed", concurrencyKey: "ck-a", timestamp: now });

        // Pre-populate two variants via direct ZADD to simulate pre-deploy backlog
        // (no counter touched). ioredis auto-prefixes keys with `runqueue:test:`,
        // so we pass un-prefixed keys.
        const variantA = testOptions.keys.queueKey(authenticatedEnvDev, baseMsg.queue, "ck-a");
        const variantB = testOptions.keys.queueKey(authenticatedEnvDev, baseMsg.queue, "ck-b");
        const ckIndexKey = testOptions.keys.ckIndexKeyFromQueue(variantA);
        for (let i = 0; i < 10; i++) {
          await queue.redis.zadd(variantA, now + i, `old-a-${i}`);
        }
        for (let i = 0; i < 5; i++) {
          await queue.redis.zadd(variantB, now + i, `old-b-${i}`);
        }
        await queue.redis.zadd(ckIndexKey, now, variantA);
        await queue.redis.zadd(ckIndexKey, now, variantB);

        // Counter should not yet exist
        const counterKey = testOptions.keys.queueLengthCounterKeyFromQueue(variantA);
        expect(await queue.redis.exists(counterKey)).toBe(0);

        // First CK enqueue: lazy init should compute 15 (pre-state), then INCR to 16
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: "new-a", concurrencyKey: "ck-a", timestamp: now + 100 }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });

        const counterVal = await queue.redis.get(counterKey);
        expect(Number(counterVal)).toBe(16);

        // lengthOfQueue should also reflect 16
        expect(await queue.lengthOfQueue(authenticatedEnvDev, baseMsg.queue)).toBe(16);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "non-CK queue regression: counter never created",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        for (let i = 0; i < 5; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({ runId: `r${i}`, timestamp: Date.now() + i }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        // Counter key should not exist for a pure non-CK queue
        const counterKey = testOptions.keys.queueLengthCounterKey(authenticatedEnvDev, "task/my-task");
        expect(await queue.redis.exists(counterKey)).toBe(0);

        // But lengthOfQueue still returns 5 via base ZCARD
        expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(5);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "mixed CK + non-CK on same base queue",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        // 3 non-CK + 2 CK on same base queue name
        for (let i = 0; i < 3; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({ runId: `nonck-${i}`, timestamp: Date.now() + i }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }
        for (let i = 0; i < 2; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `ck-${i}`,
              concurrencyKey: "ck-a",
              timestamp: Date.now() + 100 + i,
            }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        expect(await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task")).toBe(5);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "length counter decrements on dequeue",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const now = Date.now() - 1000;
        const msgs = [
          makeMessage({ runId: "r1", concurrencyKey: "ck-a", timestamp: now }),
          makeMessage({ runId: "r2", concurrencyKey: "ck-b", timestamp: now + 1 }),
        ];
        for (const msg of msgs) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: msg,
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }
        expect(await queue.lengthOfQueue(authenticatedEnvDev, msgs[0].queue)).toBe(2);

        const shard = testOptions.keys.masterQueueShardForEnvironment(msgs[0].environmentId, 2);
        await queue.testDequeueFromMasterQueue(shard, msgs[0].environmentId, 10);

        // Both dequeued → counter should be 0
        expect(await queue.lengthOfQueue(authenticatedEnvDev, msgs[0].queue)).toBe(0);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "running counter bumps when dequeueMessageFromKey is called for a CK message",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        // Seed a message at its expected key and invoke the Tracked variant directly.
        // This mirrors what dequeueMessageFromWorkerQueue would do once a worker
        // pulls a message off the worker queue.
        const msg = makeMessage({ runId: "r1", concurrencyKey: "ck-a" });
        const queueKey = testOptions.keys.queueKey(authenticatedEnvDev, msg.queue, "ck-a");
        const messageKey = testOptions.keys.messageKey(msg.orgId, msg.runId);
        const runningCounterKey =
          testOptions.keys.queueRunningCounterKeyFromQueue(queueKey);

        await queue.redis.set(
          messageKey,
          JSON.stringify({ ...msg, queue: queueKey, version: "2", workerQueue: "wq" })
        );

        for (let i = 0; i < 3; i++) {
          await queue.redis.set(
            testOptions.keys.messageKey(msg.orgId, `r${i}`),
            JSON.stringify({
              ...msg,
              runId: `r${i}`,
              queue: queueKey,
              version: "2",
              workerQueue: "wq",
            })
          );
          await queue.redis.dequeueMessageFromKeyTracked(
            testOptions.keys.messageKey(msg.orgId, `r${i}`),
            "runqueue:test:"
          );
        }

        expect(Number(await queue.redis.get(runningCounterKey))).toBe(3);

        const running = await queue.currentConcurrencyOfQueues(authenticatedEnvDev, [
          msg.queue,
        ]);
        expect(running[msg.queue]).toBe(3);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "floor-at-zero protects against spurious decrements",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const variantA = testOptions.keys.queueKey(
          authenticatedEnvDev,
          "task/my-task",
          "ck-a"
        );
        const runningCounterKey = testOptions.keys.queueRunningCounterKeyFromQueue(variantA);
        await queue.redis.set(runningCounterKey, "0");

        // Call the Tracked release directly with un-prefixed keys (ioredis prepends the prefix)
        await queue.redis.releaseConcurrencyTracked(
          testOptions.keys.queueCurrentConcurrencyKeyFromQueue(variantA),
          testOptions.keys.envCurrentConcurrencyKey(authenticatedEnvDev),
          testOptions.keys.queueCurrentDequeuedKeyFromQueue(variantA),
          testOptions.keys.envCurrentDequeuedKey(authenticatedEnvDev),
          runningCounterKey,
          "phantom-message"
        );

        expect(Number(await queue.redis.get(runningCounterKey))).toBe(0);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "lengthCounter has 24h TTL after lazy-init",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: "r1", concurrencyKey: "ck-a" }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });

        const counterKey = testOptions.keys.queueLengthCounterKey(
          authenticatedEnvDev,
          "task/my-task"
        );
        const ttl = await queue.redis.ttl(counterKey);
        // Expect roughly 86400; allow slack for test scheduling.
        expect(ttl).toBeGreaterThan(86000);
        expect(ttl).toBeLessThanOrEqual(86400);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "duplicate CK enqueue (same runId) does not inflate lengthCounter",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const msg = makeMessage({ runId: "r1", concurrencyKey: "ck-a" });

        // First enqueue: counter goes 0 -> 1
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: msg,
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });

        // Same runId again: ZADD returns 0 (already in zset), counter must stay at 1
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: msg,
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });

        expect(await queue.lengthOfQueue(authenticatedEnvDev, msg.queue)).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "nack lazy-inits lengthCounter when it expired",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const msg = makeMessage({ runId: "r1", concurrencyKey: "ck-a" });
        // Seed three messages on the CK variant so the lazy-init has a non-trivial floor.
        for (let i = 0; i < 3; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({ runId: `seed-${i}`, concurrencyKey: "ck-a" }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        // Simulate counter expiry (the 24h TTL kicked in).
        const counterKey = testOptions.keys.queueLengthCounterKey(
          authenticatedEnvDev,
          "task/my-task"
        );
        await queue.redis.del(counterKey);
        expect(await queue.redis.exists(counterKey)).toBe(0);

        // Dequeue one to currentConcurrency so we have something to nack back.
        const shard = testOptions.keys.masterQueueShardForEnvironment(msg.environmentId, 2);
        await queue.testDequeueFromMasterQueue(shard, msg.environmentId, 1);

        // Nack a CK message. nackMessageCkTracked should lazy-init the counter
        // (find 2 already in zset + 1 we're re-queuing) rather than starting from 1.
        await queue.nackMessage({
          orgId: msg.orgId,
          messageId: "seed-0",
          skipDequeueProcessing: true,
        });

        // 3 originals, 1 was dequeued (still re-queued by nack), counter should now reflect all 3.
        const observed = await queue.lengthOfQueue(authenticatedEnvDev, msg.queue);
        expect(observed).toBe(3);
      } finally {
        await queue.quit();
      }
    }
  );
});
