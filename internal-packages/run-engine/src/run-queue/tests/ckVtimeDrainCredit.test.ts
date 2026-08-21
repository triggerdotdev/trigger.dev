import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { Decimal } from "@trigger.dev/database";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";

// A draining variant parks its tag in :ckVtimeIdle before it leaves :ckVtime, so its next
// enqueue re-registers with the credit it earned instead of at the floor. This pins that
// on every route out: ack, dead-letter and TTL expiry parking it, and nack restoring it.
//
// Each test gives the variant credit first. Parking a tag that equals the floor proves
// nothing, because the dequeue reaps everything at or below the floor on its next call.

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 25,
  logger: new Logger("RunQueue", "error"),
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

const QUEUE = "task/my-task";

function createQueue(
  redisContainer: any,
  opts: { vtime?: boolean; maxAttempts?: number } = {}
): any {
  const redis = {
    keyPrefix: "runqueue:test:",
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
  };
  return new RunQueue({
    ...testOptions,
    masterQueueConsumersDisabled: true,
    workerOptions: { disabled: true },
    ...(opts.maxAttempts
      ? { retryOptions: { ...testOptions.retryOptions, maxAttempts: opts.maxAttempts } }
      : {}),
    ...(opts.vtime === false ? {} : { ckVirtualTimeScheduling: { enabled: true } }),
    queueSelectionStrategy: new FairQueueSelectionStrategy({ redis, keys: testOptions.keys }),
    redis,
  } as any) as any;
}

function makeMessage(overrides: Partial<InputPayload> = {}): InputPayload {
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
    ...overrides,
  };
}

const variantName = (ck: string) => testOptions.keys.queueKey(authenticatedEnvDev, QUEUE, ck);
const shardFor = () => testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);

describe("CK vtime: a drained variant keeps its credit", () => {
  redisTest(
    "ack parks the credit, and the next enqueue gets it back",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const t0 = Date.now() - 100_000;

        // Two on heavy so serving one leaves the variant registered with credit, and one on
        // light to hold the floor at zero while heavy's tag climbs.
        for (let i = 0; i < 2; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({ runId: `h${i}`, concurrencyKey: "heavy", timestamp: t0 + i }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: "l0", concurrencyKey: "light", timestamp: t0 + 2 }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });

        const heavy = variantName("heavy");
        const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(heavy);
        const ckVtimeIdleKey = testOptions.keys.ckVtimeIdleKeyFromQueue(heavy);

        // Both start at the floor, heavy sorts first on the lexical tie-break, so this
        // serves heavy and charges it one quantum.
        const served = await queue.testDequeueFromMasterQueue(
          shardFor(),
          authenticatedEnvDev.id,
          1
        );
        expect(served.map((m: any) => m.messageId)).toEqual(["h0"]);
        expect(await queue.redis.zscore(ckVtimeKey, heavy)).toBe("1");

        // The in-flight one: heavy still has a queued message, so this is not a drain.
        await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, "h0", {
          skipDequeueProcessing: true,
        });
        expect(await queue.redis.zscore(ckVtimeKey, heavy)).toBe("1");

        // The queued one: heavy empties, so the ack drains it.
        await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, "h1", {
          skipDequeueProcessing: true,
        });
        expect(await queue.redis.zscore(ckVtimeKey, heavy)).toBeNull();
        expect(await queue.redis.zscore(ckVtimeIdleKey, heavy)).toBe("1");

        // Back with the credit it earned. Landing at the floor here would let a variant
        // reset its tag by draining and returning, which is the whole point of the park.
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: "h2", concurrencyKey: "heavy", timestamp: t0 + 3 }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
        expect(await queue.redis.zscore(ckVtimeKey, heavy)).toBe("1");
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "nack restores the parked credit rather than re-registering at the floor",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const t0 = Date.now() - 100_000;

        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: "h0", concurrencyKey: "heavy", timestamp: t0 }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: "l0", concurrencyKey: "light", timestamp: t0 + 1 }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });

        const heavy = variantName("heavy");
        const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(heavy);
        const ckVtimeIdleKey = testOptions.keys.ckVtimeIdleKeyFromQueue(heavy);

        // Serving heavy's only message empties the variant, so the dequeue parks it at 1.
        const served = await queue.testDequeueFromMasterQueue(
          shardFor(),
          authenticatedEnvDev.id,
          1
        );
        expect(served.map((m: any) => m.messageId)).toEqual(["h0"]);
        expect(await queue.redis.zscore(ckVtimeKey, heavy)).toBeNull();
        expect(await queue.redis.zscore(ckVtimeIdleKey, heavy)).toBe("1");

        await queue.nackMessage({
          orgId: authenticatedEnvDev.organization.id,
          messageId: "h0",
          incrementAttemptCount: false,
          skipDequeueProcessing: true,
        });

        // Not the floor (0), and not one quantum behind the idle max (2) either: the exact
        // tag it left with.
        expect(await queue.redis.zscore(ckVtimeKey, heavy)).toBe("1");
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "the dead-letter path parks the credit of a variant left behind mid-deploy",
    async ({ redisContainer }) => {
      // The only route the public API has into the dead-letter drain is nacking past
      // maxAttempts, which acts on an in-flight message whose variant the vtime dequeue has
      // usually already collected. Reaching it with a live ckVtime entry needs the rollout
      // case: a flag-off instance empties the variant queue without touching ckVtime, so a
      // stranded entry is still there when the dead-letter script runs.
      //
      // Driving the script directly instead would pass whether or not the caller branches on
      // the flag, and whether or not it passes the right keys. Both were unverified until
      // this test: a mutation forcing that branch to the untracked command left the suite
      // green while the same damage done inside the script was caught.
      const on = createQueue(redisContainer, { maxAttempts: 1 });
      const off = createQueue(redisContainer, { vtime: false, maxAttempts: 1 });
      try {
        const t0 = Date.now() - 100_000;

        for (let i = 0; i < 2; i++) {
          await on.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({ runId: `h${i}`, concurrencyKey: "heavy", timestamp: t0 + i }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }
        await on.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: "l0", concurrencyKey: "light", timestamp: t0 + 5_000 }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });

        const heavy = variantName("heavy");
        const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(heavy);
        const ckVtimeIdleKey = testOptions.keys.ckVtimeIdleKeyFromQueue(heavy);

        await on.testDequeueFromMasterQueue(shardFor(), authenticatedEnvDev.id, 1);
        expect(await on.redis.zscore(ckVtimeKey, heavy)).toBe("1");
        await on.acknowledgeMessage(authenticatedEnvDev.organization.id, "h0", {
          skipDequeueProcessing: true,
        });

        // The flag-off instance empties heavy without collecting it, which is what leaves the
        // entry stranded at its earned tag with an in-flight message to nack.
        const strandedServe = await off.testDequeueFromMasterQueue(
          shardFor(),
          authenticatedEnvDev.id,
          1
        );
        expect(strandedServe.map((m: any) => m.messageId)).toEqual(["h1"]);
        expect(await on.redis.zscore(ckVtimeKey, heavy)).toBe("1");

        // maxAttempts is 1, so this goes straight to the dead-letter queue.
        await on.nackMessage({
          orgId: authenticatedEnvDev.organization.id,
          messageId: "h1",
          skipDequeueProcessing: true,
        });

        expect(await on.redis.zscore(ckVtimeKey, heavy)).toBeNull();
        expect(await on.redis.zscore(ckVtimeIdleKey, heavy)).toBe("1");
      } finally {
        await off.quit();
        await on.quit();
      }
    }
  );

  redisTest("TTL expiry parks the credit of the variant it sweeps", async ({ redisContainer }) => {
    // The sweep discovers its queues inside the script, so there is no public route and no
    // key argument to get wrong; driving the command is the only option. What is worth
    // pinning is that it parks before removing, same as the other two drains.
    const queue = createQueue(redisContainer);
    try {
      const t0 = Date.now() - 100_000;

      for (let i = 0; i < 2; i++) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: `h${i}`, concurrencyKey: "heavy", timestamp: t0 + i }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
      }
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "l0", concurrencyKey: "light", timestamp: t0 + 5_000 }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });

      const heavy = variantName("heavy");
      const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(heavy);
      const ckVtimeIdleKey = testOptions.keys.ckVtimeIdleKeyFromQueue(heavy);

      await queue.testDequeueFromMasterQueue(shardFor(), authenticatedEnvDev.id, 1);
      await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, "h0", {
        skipDequeueProcessing: true,
      });
      expect(await queue.redis.zscore(ckVtimeKey, heavy)).toBe("1");

      const shard = shardFor();
      const ttlQueueKey = testOptions.keys.ttlQueueKeyForShard(shard);
      await queue.redis.zadd(
        ttlQueueKey,
        Date.now() - 1000,
        `${heavy}|h1|${authenticatedEnvDev.organization.id}`
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

      expect(await queue.redis.zscore(ckVtimeKey, heavy)).toBeNull();
      expect(await queue.redis.zscore(ckVtimeIdleKey, heavy)).toBe("1");
    } finally {
      await queue.quit();
    }
  });
});
