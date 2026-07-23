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
import { rescoreCkIndex } from "../ckRescorer.js";

const keys = new RunQueueFullKeyProducer();
const env = {
  id: "e-ck",
  type: "PRODUCTION" as const,
  maximumConcurrencyLimit: 10,
  concurrencyLimitBurstFactor: new Decimal(1.0),
  project: { id: "p-ck" },
  organization: { id: "o-ck" },
};
function msg(ck: string, runId: string): InputPayload {
  return {
    runId, orgId: "o-ck", projectId: "p-ck", environmentId: "e-ck",
    environmentType: "PRODUCTION", queue: "task/base", concurrencyKey: ck,
    timestamp: Date.now(), attempt: 0,
  };
}

describe("rescoreCkIndex", () => {
  redisTest("makes the Lua's oldest-first pick follow the given order", async ({ redisContainer }) => {
    const redisOptions = { keyPrefix: "rq:ck:", host: redisContainer.getHost(), port: redisContainer.getPort() };
    const queue = new RunQueue({
      name: "rq-ck", tracer: trace.getTracer("rq-ck"), logger: new Logger("RunQueueCk", "error"),
      defaultEnvConcurrency: 10, shardCount: 1, masterQueueConsumersDisabled: true,
      workerOptions: { disabled: true }, keys, redis: redisOptions,
      queueSelectionStrategy: new FairQueueSelectionStrategy({ redis: redisOptions, keys }),
    });
    const raw = createRedisClient(redisOptions);
    try {
      for (const ck of ["ck1", "ck2", "ck3"]) {
        await queue.enqueueMessage({ env, message: msg(ck, `${ck}-r`), workerQueue: "e-ck", skipDequeueProcessing: true });
      }
      const base = keys.queueKey(env, "task/base", "ck1");
      const reader = new CkReader(raw, keys, "rq:ck:");
      const active = await reader.readActiveCks(base);
      const ckOf = (k: string) => active.find((a) => a.concurrencyKey === k)!.ckQueue;

      // Force order ck3, ck1, ck2
      const now = Date.now();
      await rescoreCkIndex(raw, keys, base, [ckOf("ck3"), ckOf("ck1"), ckOf("ck2")], now);

      const ckIndexKey = keys.ckIndexKeyFromQueue(base);
      const ordered = await raw.zrangebyscore(ckIndexKey, "-inf", now);
      const cks = ordered.map((m) => keys.descriptorFromQueue(m).concurrencyKey);
      expect(cks).toEqual(["ck3", "ck1", "ck2"]);
    } finally {
      await raw.quit();
      await queue.quit();
    }
  });
});
