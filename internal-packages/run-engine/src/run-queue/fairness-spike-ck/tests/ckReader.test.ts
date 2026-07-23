import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { createRedisClient } from "@internal/redis";
import { Decimal } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { RunQueue } from "../../index.js";
import { FairQueueSelectionStrategy } from "../../fairQueueSelectionStrategy.js";
import { RunQueueFullKeyProducer } from "../../keyProducer.js";
import type { InputPayload } from "../../types.js";
import { CkReader } from "../ckReader.js";

const keys = new RunQueueFullKeyProducer();

const env = {
  id: "e-ck",
  type: "PRODUCTION" as const,
  maximumConcurrencyLimit: 10,
  concurrencyLimitBurstFactor: new Decimal(1.0),
  project: { id: "p-ck" },
  organization: { id: "o-ck" },
};

function msg(concurrencyKey: string, runId: string): InputPayload {
  return {
    runId,
    orgId: "o-ck",
    projectId: "p-ck",
    environmentId: "e-ck",
    environmentType: "PRODUCTION",
    queue: "task/base",
    concurrencyKey,
    timestamp: Date.now(),
    attempt: 0,
  };
}

describe("CkReader", () => {
  redisTest("reads concurrency keys from the ck index", async ({ redisContainer }) => {
    const redisOptions = {
      keyPrefix: "rq:ck:",
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
    };
    const queue = new RunQueue({
      name: "rq-ck",
      tracer: trace.getTracer("rq-ck"),
      logger: new Logger("RunQueueCk", "error"),
      defaultEnvConcurrency: 10,
      shardCount: 1,
      masterQueueConsumersDisabled: true,
      workerOptions: { disabled: true },
      keys,
      redis: redisOptions,
      queueSelectionStrategy: new FairQueueSelectionStrategy({ redis: redisOptions, keys }),
    });
    const raw = createRedisClient(redisOptions);

    try {
      await queue.enqueueMessage({ env, message: msg("ck1", "r1"), workerQueue: "e-ck", skipDequeueProcessing: true });
      await queue.enqueueMessage({ env, message: msg("ck2", "r2"), workerQueue: "e-ck", skipDequeueProcessing: true });

      // Discover the raw member format for grounding.
      const ckIndexKey = keys.ckIndexKeyFromQueue(keys.queueKey(env, "task/base", "ck1"));
      const dump = await raw.zrange(ckIndexKey, 0, -1, "WITHSCORES");
      // eslint-disable-next-line no-console
      console.log("CK_INDEX_DUMP", JSON.stringify(dump));

      const reader = new CkReader(raw, keys, "rq:ck:");
      const active = await reader.readActiveCks(keys.queueKey(env, "task/base", "ck1"));
      // eslint-disable-next-line no-console
      console.log("CK_ACTIVE", JSON.stringify(active));

      expect(active.map((a) => a.concurrencyKey).sort()).toEqual(["ck1", "ck2"]);
      expect(active.every((a) => typeof a.headScore === "number")).toBe(true);
    } finally {
      await raw.quit();
      await queue.quit();
    }
  });
});
