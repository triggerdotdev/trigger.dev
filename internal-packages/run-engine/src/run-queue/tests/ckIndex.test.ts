import { assertNonNullable, redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { describe } from "node:test";
import { setTimeout } from "node:timers/promises";
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

describe("CK Index", () => {
  redisTest(
    "enqueue with CK creates CK index entry and :ck:* master queue entry",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const msg = makeMessage({ runId: "r1", concurrencyKey: "ck-a" });

        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: msg,
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });

        // Check that the CK-specific sorted set has the message
        const queueLength = await queue.lengthOfQueue(
          authenticatedEnvDev,
          msg.queue,
          msg.concurrencyKey
        );
        expect(queueLength).toBe(1);

        // Check master queue: should have :ck:* entry, not :ck:ck-a
        const masterQueueKey = testOptions.keys.masterQueueKeyForShard(
          testOptions.keys.masterQueueShardForEnvironment(msg.environmentId, 2)
        );
        const masterMembers = await queue.redis.zrange(
          masterQueueKey,
          0,
          -1,
          "WITHSCORES"
        );
        // Should have exactly one member ending with :ck:*
        const ckWildcardMembers = masterMembers.filter(
          (m, i) => i % 2 === 0 && m.endsWith(":ck:*")
        );
        expect(ckWildcardMembers.length).toBe(1);

        // Should NOT have :ck:ck-a member
        const oldFormatMembers = masterMembers.filter(
          (m, i) => i % 2 === 0 && m.endsWith(":ck:ck-a")
        );
        expect(oldFormatMembers.length).toBe(0);

        // Check CK index has the CK queue
        const ckIndexKey = testOptions.keys.ckIndexKeyFromQueue(
          testOptions.keys.queueKey(authenticatedEnvDev, msg.queue, msg.concurrencyKey)
        );
        const ckIndexMembers = await queue.redis.zrange(ckIndexKey, 0, -1);
        expect(ckIndexMembers.length).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "multiple CKs result in single master queue entry",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const now = Date.now();
        const msg1 = makeMessage({
          runId: "r1",
          concurrencyKey: "ck-a",
          timestamp: now,
        });
        const msg2 = makeMessage({
          runId: "r2",
          concurrencyKey: "ck-b",
          timestamp: now + 100,
        });
        const msg3 = makeMessage({
          runId: "r3",
          concurrencyKey: "ck-c",
          timestamp: now + 200,
        });

        for (const msg of [msg1, msg2, msg3]) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: msg,
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        // Master queue should have exactly ONE entry (the :ck:* wildcard)
        const masterQueueKey = testOptions.keys.masterQueueKeyForShard(
          testOptions.keys.masterQueueShardForEnvironment(msg1.environmentId, 2)
        );
        const masterMembers = await queue.redis.zrange(
          masterQueueKey,
          0,
          -1
        );
        // Filter to only members for our queue
        const ourMembers = masterMembers.filter((m) =>
          m.includes("queue:task/my-task")
        );
        expect(ourMembers.length).toBe(1);
        expect(ourMembers[0]).toContain(":ck:*");

        // CK index should have 3 entries
        const ckIndexKey = testOptions.keys.ckIndexKeyFromQueue(
          testOptions.keys.queueKey(authenticatedEnvDev, msg1.queue, msg1.concurrencyKey)
        );
        const ckIndexMembers = await queue.redis.zrange(ckIndexKey, 0, -1);
        expect(ckIndexMembers.length).toBe(3);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "dequeue from CK queue distributes across sub-queues",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const now = Date.now() - 1000; // In the past so they're ready
        const msg1 = makeMessage({
          runId: "r1",
          concurrencyKey: "ck-a",
          timestamp: now,
        });
        const msg2 = makeMessage({
          runId: "r2",
          concurrencyKey: "ck-b",
          timestamp: now + 1,
        });
        const msg3 = makeMessage({
          runId: "r3",
          concurrencyKey: "ck-a",
          timestamp: now + 2,
        });

        for (const msg of [msg1, msg2, msg3]) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: msg,
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        // Dequeue via the master queue consumer
        const shard = testOptions.keys.masterQueueShardForEnvironment(
          msg1.environmentId,
          2
        );
        const messages = await queue.testDequeueFromMasterQueue(shard, msg1.environmentId, 10);

        // Should dequeue messages from both CK sub-queues
        expect(messages).toBeDefined();
        // We should get at least 2 messages (one from each CK)
        // The exact order depends on CK index scoring
        expect(messages!.length).toBeGreaterThanOrEqual(2);

        const dequeuedRunIds = messages!.map((m: any) => m.messageId);
        // r1 (ck-a, oldest) and r2 (ck-b) should be dequeued
        expect(dequeuedRunIds).toContain("r1");
        expect(dequeuedRunIds).toContain("r2");
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "empty CK sub-queue is removed from CK index",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const now = Date.now() - 1000;
        const msg1 = makeMessage({
          runId: "r1",
          concurrencyKey: "ck-a",
          timestamp: now,
        });
        const msg2 = makeMessage({
          runId: "r2",
          concurrencyKey: "ck-b",
          timestamp: now + 1,
        });

        for (const msg of [msg1, msg2]) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: msg,
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        // CK index should have 2 entries initially
        const ckIndexKey = testOptions.keys.ckIndexKeyFromQueue(
          testOptions.keys.queueKey(authenticatedEnvDev, msg1.queue, msg1.concurrencyKey)
        );
        let ckIndexMembers = await queue.redis.zrange(ckIndexKey, 0, -1);
        expect(ckIndexMembers.length).toBe(2);

        // Dequeue both messages
        const shard = testOptions.keys.masterQueueShardForEnvironment(
          msg1.environmentId,
          2
        );
        await queue.testDequeueFromMasterQueue(shard, msg1.environmentId, 10);

        // CK index should be empty (both sub-queues drained)
        ckIndexMembers = await queue.redis.zrange(ckIndexKey, 0, -1);
        expect(ckIndexMembers.length).toBe(0);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "empty CK index removes :ck:* from master queue",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const now = Date.now() - 1000;
        const msg = makeMessage({
          runId: "r1",
          concurrencyKey: "ck-a",
          timestamp: now,
        });

        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: msg,
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });

        const masterQueueKey = testOptions.keys.masterQueueKeyForShard(
          testOptions.keys.masterQueueShardForEnvironment(msg.environmentId, 2)
        );

        // Master queue should have :ck:* entry
        let masterMembers = await queue.redis.zrange(masterQueueKey, 0, -1);
        expect(masterMembers.length).toBe(1);

        // Dequeue the message
        const shard = testOptions.keys.masterQueueShardForEnvironment(
          msg.environmentId,
          2
        );
        await queue.testDequeueFromMasterQueue(shard, msg.environmentId, 10);

        // Master queue should be empty
        masterMembers = await queue.redis.zrange(masterQueueKey, 0, -1);
        expect(masterMembers.length).toBe(0);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "mixed CK and non-CK queues in same shard",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const now = Date.now() - 1000;

        // Non-CK message
        const msgNoCk = makeMessage({
          runId: "r-no-ck",
          timestamp: now,
        });

        // CK messages
        const msgCk1 = makeMessage({
          runId: "r-ck-1",
          concurrencyKey: "ck-a",
          timestamp: now + 1,
        });
        const msgCk2 = makeMessage({
          runId: "r-ck-2",
          concurrencyKey: "ck-b",
          timestamp: now + 2,
        });

        for (const msg of [msgNoCk, msgCk1, msgCk2]) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: msg,
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        // Master queue should have 2 entries: one non-CK queue and one :ck:*
        const masterQueueKey = testOptions.keys.masterQueueKeyForShard(
          testOptions.keys.masterQueueShardForEnvironment(msgNoCk.environmentId, 2)
        );
        const masterMembers = await queue.redis.zrange(masterQueueKey, 0, -1);
        expect(masterMembers.length).toBe(2);

        // One should be the non-CK queue, one should be :ck:*
        const ckWildcard = masterMembers.filter((m) => m.endsWith(":ck:*"));
        const nonCk = masterMembers.filter(
          (m) => !m.includes(":ck:")
        );
        expect(ckWildcard.length).toBe(1);
        expect(nonCk.length).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "acknowledge CK message rebalances CK index and master queue",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const now = Date.now() - 1000;
        const msg1 = makeMessage({
          runId: "r1",
          concurrencyKey: "ck-a",
          timestamp: now,
        });
        const msg2 = makeMessage({
          runId: "r2",
          concurrencyKey: "ck-a",
          timestamp: now + 100,
        });

        for (const msg of [msg1, msg2]) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: msg,
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        // Dequeue one message
        const shard = testOptions.keys.masterQueueShardForEnvironment(
          msg1.environmentId,
          2
        );
        const messages = await queue.testDequeueFromMasterQueue(shard, msg1.environmentId, 1);
        expect(messages!.length).toBe(1);
        expect(messages![0].messageId).toBe("r1");

        // Acknowledge the dequeued message
        await queue.acknowledgeMessage(msg1.orgId, "r1", {
          skipDequeueProcessing: true,
        });

        // CK index should still have the ck-a entry (r2 is still queued)
        const ckIndexKey = testOptions.keys.ckIndexKeyFromQueue(
          testOptions.keys.queueKey(authenticatedEnvDev, msg1.queue, msg1.concurrencyKey)
        );
        const ckIndexMembers = await queue.redis.zrange(ckIndexKey, 0, -1);
        expect(ckIndexMembers.length).toBe(1);

        // Master queue should still have the :ck:* entry
        const masterQueueKey = testOptions.keys.masterQueueKeyForShard(shard);
        const masterMembers = await queue.redis.zrange(masterQueueKey, 0, -1);
        expect(masterMembers.length).toBe(1);
        expect(masterMembers[0]).toContain(":ck:*");

        // Dequeue and ack the last message
        const messages2 = await queue.testDequeueFromMasterQueue(shard, msg1.environmentId, 1);
        expect(messages2!.length).toBe(1);
        await queue.acknowledgeMessage(msg2.orgId, "r2", {
          skipDequeueProcessing: true,
        });

        // CK index should be empty
        const ckIndexMembers2 = await queue.redis.zrange(ckIndexKey, 0, -1);
        expect(ckIndexMembers2.length).toBe(0);

        // Master queue should be empty
        const masterMembers2 = await queue.redis.zrange(masterQueueKey, 0, -1);
        expect(masterMembers2.length).toBe(0);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "nack CK message rebalances CK index",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const now = Date.now() - 1000;
        const msg = makeMessage({
          runId: "r1",
          concurrencyKey: "ck-a",
          timestamp: now,
        });

        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: msg,
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });

        // Dequeue the message
        const shard = testOptions.keys.masterQueueShardForEnvironment(
          msg.environmentId,
          2
        );
        const messages = await queue.testDequeueFromMasterQueue(shard, msg.environmentId, 1);
        expect(messages!.length).toBe(1);

        // Nack the message (re-enqueue)
        await queue.nackMessage({
          orgId: msg.orgId,
          messageId: "r1",
          retryAt: Date.now() + 5000,
          incrementAttemptCount: false,
          skipDequeueProcessing: true,
        });

        // CK index should have the ck-a entry (message re-enqueued)
        const ckIndexKey = testOptions.keys.ckIndexKeyFromQueue(
          testOptions.keys.queueKey(authenticatedEnvDev, msg.queue, msg.concurrencyKey)
        );
        const ckIndexMembers = await queue.redis.zrange(ckIndexKey, 0, -1);
        expect(ckIndexMembers.length).toBe(1);

        // Master queue should have the :ck:* entry
        const masterQueueKey = testOptions.keys.masterQueueKeyForShard(shard);
        const masterMembers = await queue.redis.zrange(masterQueueKey, 0, -1);
        expect(masterMembers.length).toBe(1);
        expect(masterMembers[0]).toContain(":ck:*");

        // No old-format entries
        const oldFormatMembers = masterMembers.filter(
          (m) => m.includes(":ck:") && !m.endsWith(":ck:*")
        );
        expect(oldFormatMembers.length).toBe(0);
      } finally {
        await queue.quit();
      }
    }
  );
});
