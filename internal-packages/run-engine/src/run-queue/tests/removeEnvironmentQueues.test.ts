import { createRedisClient } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { describe, expect, vi } from "vitest";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";

vi.setConfig({ testTimeout: 60_000 });

const keys = new RunQueueFullKeyProducer();
const PREFIX = "runqueue:test:";

describe("RunQueue.removeEnvironmentQueuesFromMasterQueue", () => {
  // Catches: a failing ZREM leaving the removal pending forever instead of rejecting.
  redisTest("rejects when removing the queues fails", async ({ redisContainer }) => {
    const host = redisContainer.getHost();
    const port = redisContainer.getPort();
    const admin = createRedisClient({ host, port });
    await admin.acl("SETUSER", "nozrem", "on", ">secret", "~*", "&*", "+@all", "-zrem");

    const redis = { keyPrefix: PREFIX, host, port, username: "nozrem", password: "secret" };
    const queue = new RunQueue({
      name: "rq",
      tracer: trace.getTracer("rq"),
      workers: 1,
      defaultEnvConcurrency: 25,
      logger: new Logger("RunQueue", "error"),
      retryOptions: { maxAttempts: 1, minTimeoutInMs: 10, maxTimeoutInMs: 10 },
      keys,
      shardCount: 2,
      masterQueueConsumersDisabled: true,
      queueSelectionStrategy: new FairQueueSelectionStrategy({
        redis: { ...redis, lazyConnect: true },
        keys,
      }),
      redis,
    });

    try {
      await admin.zadd(
        `${PREFIX}${keys.masterQueueKeyForEnvironment("env1", 2)}`,
        0,
        keys.queueKey("org1", "project1", "env1", "queue1")
      );

      const outcome = await Promise.race([
        queue.removeEnvironmentQueuesFromMasterQueue("env1", "org1", "project1").then(
          () => "resolved",
          (error: Error) => error.message
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 5_000)),
      ]);

      expect(outcome).toMatch(/NOPERM/);
    } finally {
      await queue.quit();
      await admin.quit();
    }
  });
});
