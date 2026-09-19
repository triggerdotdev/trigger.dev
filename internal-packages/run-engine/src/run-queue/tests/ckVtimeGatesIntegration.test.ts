import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { Decimal } from "@trigger.dev/database";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";

// The vtime dequeue must enforce queue-gates and total-concurrency the same way the
// flag-off dequeue does. Both features off in prod today, but nothing exercised the
// combination, and the interim vtime dequeue ignored gates entirely.

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 100,
  logger: new Logger("RunQueue", "error"),
  retryOptions: {
    maxAttempts: 5,
    factor: 1.1,
    minTimeoutInMs: 100,
    maxTimeoutInMs: 1000,
    randomize: true,
  },
  keys: new RunQueueFullKeyProducer(),
};

const authenticatedEnvDev = {
  id: "e1234",
  type: "DEVELOPMENT" as const,
  maximumConcurrencyLimit: 100,
  concurrencyLimitBurstFactor: new Decimal(2.0),
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

const QUEUE = "task/my-task";

function createQueue(redisContainer: any) {
  const redis = {
    keyPrefix: "runqueue:test:",
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
  };
  return new RunQueue({
    ...testOptions,
    masterQueueConsumersDisabled: true,
    workerOptions: { disabled: true },
    ckVirtualTimeScheduling: { enabled: true },
    totalConcurrencyEnabled: true,
    gatesEnabled: true,
    queueSelectionStrategy: new FairQueueSelectionStrategy({ redis, keys: testOptions.keys }),
    redis,
  } as any) as any;
}

function makeMessage(o: Partial<InputPayload> = {}): InputPayload {
  return {
    runId: "r1",
    taskIdentifier: QUEUE,
    orgId: "o1234",
    projectId: "p1234",
    environmentId: "e1234",
    environmentType: "DEVELOPMENT",
    queue: QUEUE,
    timestamp: Date.now(),
    attempt: 0,
    ...o,
  };
}

const shardFor = () => testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);

describe("CK vtime dequeue enforces gates + total concurrency", () => {
  redisTest("total-concurrency cap holds on the vtime dequeue", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, QUEUE, 50);
      await queue.updateQueueTotalConcurrencyLimits(authenticatedEnvDev, QUEUE, 2);
      const t0 = Date.now() - 100_000;
      // 4 distinct ck variants, one run each. The vtime dequeue serves at most one per
      // variant per call, so without a total cap all 4 would be served this call; the cap
      // of 2 is the only thing that can hold it to 2 (a variant count of 4 rules out the
      // one-per-variant behaviour masking the cap).
      for (const [i, ck] of ["a", "b", "c", "d"].entries()) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: `r${i}`, concurrencyKey: ck, timestamp: t0 + i }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
      }
      const served = await queue.testDequeueFromMasterQueue(shardFor(), authenticatedEnvDev.id, 10);
      // Total cap = 2, so at most 2 may be served even though 4 variants are eligible.
      expect(served.length).toBe(2);
      expect(await queue.totalConcurrencyOfQueue(authenticatedEnvDev, QUEUE)).toBe(2);
    } finally {
      await queue.quit();
    }
  });

  redisTest("a per-gate cap holds on the vtime dequeue", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, QUEUE, 50);
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "shared-gate", 1);
      const t0 = Date.now() - 100_000;
      // 2 runs on different ck variants, both holding the SAME gate (explicit shared gate
      // key) limited to 1. Without the explicit key an unkeyed gate inherits each message's
      // own concurrencyKey and the two would not share the limit.
      for (const [i, ck] of ["a", "b"].entries()) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({
            runId: `r${i}`,
            concurrencyKey: ck,
            timestamp: t0 + i,
            gates: [{ queue: "shared-gate", concurrencyKey: "tenant" }],
          } as any),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
      }
      const served = await queue.testDequeueFromMasterQueue(shardFor(), authenticatedEnvDev.id, 10);
      expect(served.length).toBe(1);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "the vtime TTL sweep releases a gated run's queued counter",
    async ({ redisContainer }) => {
      // A queued gated run counts in its gate's queued counter (enqueue does +1). If it TTL-
      // expires, the vtime sweep must decrement it, or the counter leaks. The flag-off sweep
      // does this; the interim vtime sweep did not.
      const queue = createQueue(redisContainer);
      try {
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, QUEUE, 50);
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, "gate-q", 5);
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({
            runId: "r-exp",
            concurrencyKey: "k",
            timestamp: Date.now() - 100_000,
            ttlExpiresAt: Date.now() - 1000,
            gates: [{ queue: "gate-q", concurrencyKey: "tenant" }],
          } as any),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });

        const gateBase = testOptions.keys.queueKey(authenticatedEnvDev, "gate-q");
        const counterKey = `${gateBase}:gateQueuedCounter`;
        // Enqueue incremented the gate's queued counter.
        expect(Number(await queue.redis.get(counterKey))).toBe(1);

        const v = testOptions.keys.queueKey(authenticatedEnvDev, QUEUE, "k");
        const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
        const ttlQueueKey = testOptions.keys.ttlQueueKeyForShard(shard);
        await queue.redis.zadd(
          ttlQueueKey,
          Date.now() - 1000,
          `${v}|r-exp|${authenticatedEnvDev.organization.id}`
        );
        await queue.redis.expireTtlRunsVtimeTracked(
          ttlQueueKey,
          "runqueue:test:",
          Date.now().toString(),
          "10",
          "2",
          "ttlworker",
          "ttlworkeritems",
          "30000",
          "86400"
        );

        // Expiry must have decremented the counter back to 0 (no leak).
        expect(Number((await queue.redis.get(counterKey)) ?? "0")).toBe(0);
      } finally {
        await queue.quit();
      }
    }
  );
});
