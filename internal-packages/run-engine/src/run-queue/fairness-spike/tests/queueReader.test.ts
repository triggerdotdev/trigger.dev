import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { createRedisClient } from "@internal/redis";
import { Decimal } from "@trigger.dev/database";
import { describe } from "node:test";
import { RunQueue } from "../../index.js";
import { FairQueueSelectionStrategy } from "../../fairQueueSelectionStrategy.js";
import { RunQueueFullKeyProducer } from "../../keyProducer.js";
import type { InputPayload } from "../../types.js";
import { SpikeQueueReader } from "../types.js";

const keys = new RunQueueFullKeyProducer();

const authenticatedEnvProd = {
  id: "e-spike",
  type: "PRODUCTION" as const,
  maximumConcurrencyLimit: 10,
  concurrencyLimitBurstFactor: new Decimal(1.0),
  project: { id: "p-spike" },
  organization: { id: "o-spike" },
};

function makeMessage(queue: string, runId: string): InputPayload {
  return {
    runId,
    orgId: "o-spike",
    projectId: "p-spike",
    environmentId: "e-spike",
    environmentType: "PRODUCTION",
    queue,
    timestamp: Date.now(),
    attempt: 0,
  };
}

describe("SpikeQueueReader", () => {
  redisTest("reads active base queues from the master queue", async ({ redisContainer }) => {
    const redisOptions = {
      keyPrefix: "runqueue:spike:",
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
    };

    const queue = new RunQueue({
      name: "rq-spike",
      tracer: trace.getTracer("rq-spike"),
      logger: new Logger("RunQueueSpike", "error"),
      defaultEnvConcurrency: 10,
      shardCount: 1,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
      keys,
      redis: redisOptions,
      queueSelectionStrategy: new FairQueueSelectionStrategy({ redis: redisOptions, keys }),
    });

    const rawRedis = createRedisClient(redisOptions);

    try {
      await queue.enqueueMessage({
        env: authenticatedEnvProd,
        message: makeMessage("task/g1", "task/g1-0"),
        workerQueue: authenticatedEnvProd.id,
        skipDequeueProcessing: true,
      });
      await queue.enqueueMessage({
        env: authenticatedEnvProd,
        message: makeMessage("task/g2", "task/g2-0"),
        workerQueue: authenticatedEnvProd.id,
        skipDequeueProcessing: true,
      });

      const reader = new SpikeQueueReader(rawRedis, keys);
      const active = await reader.readActiveQueues(keys.masterQueueKeyForShard(0));

      expect(active.map((a) => a.groupId).sort()).toEqual(["task/g1", "task/g2"]);
      expect(active.every((a) => typeof a.headScore === "number")).toBe(true);
      expect(active.every((a) => a.env.envId === "e-spike")).toBe(true);
    } finally {
      await rawRedis.quit();
      await queue.quit();
    }
  });
});
