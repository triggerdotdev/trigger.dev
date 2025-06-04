import { createRedisClient } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { describe } from "node:test";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 25,
  logger: new Logger("RunQueue", "debug"),
  retryOptions: {
    maxAttempts: 5,
    factor: 1.1,
    minTimeoutInMs: 100,
    maxTimeoutInMs: 1_000,
    randomize: true,
  },
  keys: new RunQueueFullKeyProducer(),
  shardCount: 2,
};

vi.setConfig({ testTimeout: 60_000 });

describe("RunQueue.migrateLegacyMasterQueue", () => {
  redisTest(
    "should migrate the legacy master queue to the new master queues",
    async ({ redisContainer, redisOptions }) => {
      const queue = new RunQueue({
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

      // We need to create a legacy master queue and fill it with some queues that have their own sorted sets with some messages
      const legacyMasterQueue = "legacy-master-queue";
      const legacyMasterQueueKey = testOptions.keys.legacyMasterQueueKey(legacyMasterQueue);

      const redis = createRedisClient({
        keyPrefix: "runqueue:test:",
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      });

      const queue1 = testOptions.keys.queueKey("org1", "project1", "env1", "queue1");
      const queue2 = testOptions.keys.queueKey("org1", "project1", "env1", "queue2");
      const queue3 = testOptions.keys.queueKey("org1", "project1", "env2", "queue3");
      const queue4 = testOptions.keys.queueKey("org1", "project1", "env2", "queue4");
      const queue5 = testOptions.keys.queueKey("org1", "project1", "env3", "queue5");
      const queue6 = testOptions.keys.queueKey("org1", "project1", "env3", "queue6");
      const queue7 = testOptions.keys.queueKey("org1", "project1", "env4", "queue7");
      const queue8 = testOptions.keys.queueKey("org1", "project1", "env4", "queue8");

      await redis.zadd(legacyMasterQueueKey, 0, queue1);
      await redis.zadd(legacyMasterQueueKey, 0, queue2);
      await redis.zadd(legacyMasterQueueKey, 0, queue3);
      await redis.zadd(legacyMasterQueueKey, 0, queue4);
      await redis.zadd(legacyMasterQueueKey, 0, queue5);
      await redis.zadd(legacyMasterQueueKey, 0, queue6);
      await redis.zadd(legacyMasterQueueKey, 0, queue7);
      await redis.zadd(legacyMasterQueueKey, 0, queue8);

      // Add messages to the queue with various hardcoded unix epoch timestamps
      await redis.zadd(queue1, 1717334000, "message1");
      await redis.zadd(queue1, 1717334001, "message2");

      await redis.zadd(queue2, 1717334002, "message3");

      await redis.zadd(queue3, 1717334003, "message4");

      await redis.zadd(queue4, 1717334004, "message5");

      await redis.zadd(queue5, 1717334005, "message6");

      await redis.zadd(queue6, 1717334006, "message7");

      await redis.zadd(queue7, 1717334400, "message7");

      // queue8 has no messages, even though it's in the legacy master queue

      await queue.migrateLegacyMasterQueue(legacyMasterQueue);

      // Inspect the new master queues
      const shard1MasterQueueKey = testOptions.keys.masterQueueKeyForShard(0);
      const shard2MasterQueueKey = testOptions.keys.masterQueueKeyForShard(1);

      // The legacy master queue should be empty
      const shard1Queues = await redis.zrange(shard1MasterQueueKey, 0, -1, "WITHSCORES");

      expect(shard1Queues).toEqual([
        "{org:org1}:proj:project1:env:env1:queue:queue1",
        "1717334000",
        "{org:org1}:proj:project1:env:env1:queue:queue2",
        "1717334002",
        "{org:org1}:proj:project1:env:env2:queue:queue3",
        "1717334003",
        "{org:org1}:proj:project1:env:env2:queue:queue4",
        "1717334004",
      ]);

      const shard2Queues = await redis.zrange(shard2MasterQueueKey, 0, -1, "WITHSCORES");

      expect(shard2Queues).toEqual([
        "{org:org1}:proj:project1:env:env3:queue:queue5",
        "1717334005",
        "{org:org1}:proj:project1:env:env3:queue:queue6",
        "1717334006",
        "{org:org1}:proj:project1:env:env4:queue:queue7",
        "1717334400",
      ]);

      await queue.quit();
      await redis.quit();
    }
  );
});
