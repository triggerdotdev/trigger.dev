import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { Decimal } from "@trigger.dev/database";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";

// Pass 2 repairs a variant that reached ckIndex with no ckVtime entry, which during a
// mixed rollout is one a flag-off instance re-enqueued after a flag-on instance parked its
// tag. Both of its routes used to repair at the floor and drop the parked credit: the
// discovery batch registered there, and an immediate serve took the floor as its tag,
// advanced it, and re-parked the lower value over the credit the variant had earned.
//
// The floor is held at 0 by a second variant throughout, so a restored tag can't be
// mistaken for it.

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

describe("CK vtime: pass-2 repair keeps parked credit", () => {
  const setup = async (redisContainer: any) => {
    const on = createQueue(redisContainer);
    const off = createQueue(redisContainer, { vtime: false });
    const t0 = Date.now() - 100_000;

    await on.enqueueMessage({
      env: authenticatedEnvDev,
      message: makeMessage({ runId: "h0", concurrencyKey: "heavy", timestamp: t0 }),
      workerQueue: authenticatedEnvDev.id,
      skipDequeueProcessing: true,
    });
    await on.enqueueMessage({
      env: authenticatedEnvDev,
      message: makeMessage({ runId: "l0", concurrencyKey: "light", timestamp: t0 + 1 }),
      workerQueue: authenticatedEnvDev.id,
      skipDequeueProcessing: true,
    });

    const heavy = variantName("heavy");
    const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(heavy);
    const ckVtimeIdleKey = testOptions.keys.ckVtimeIdleKeyFromQueue(heavy);

    // Serving heavy's only message drains it, so the dequeue parks its tag.
    await on.testDequeueFromMasterQueue(shardFor(), authenticatedEnvDev.id, 1);
    expect(await on.redis.zscore(ckVtimeKey, heavy)).toBeNull();
    // Lifted clear of the floor so a restore is unambiguous.
    await on.redis.zadd(ckVtimeIdleKey, 5, heavy);
    await on.acknowledgeMessage(authenticatedEnvDev.organization.id, "h0", {
      skipDequeueProcessing: true,
    });

    // The rollout step: an instance with the flag off re-enqueues, so heavy reaches
    // ckIndex without a ckVtime entry and pass 2 is the only thing that can see it.
    await off.enqueueMessage({
      env: authenticatedEnvDev,
      message: makeMessage({ runId: "h1", concurrencyKey: "heavy", timestamp: t0 + 2 }),
      workerQueue: authenticatedEnvDev.id,
      skipDequeueProcessing: true,
    });
    expect(await on.redis.zscore(ckVtimeKey, heavy)).toBeNull();

    return { on, off, heavy, ckVtimeKey, ckVtimeIdleKey };
  };

  redisTest("the discovery batch registers it at its parked tag", async ({ redisContainer }) => {
    const { on, off, heavy, ckVtimeKey } = await setup(redisContainer);
    try {
      // maxCount 1, so pass 1 fills the batch on light and pass 2 only discovers.
      await on.testDequeueFromMasterQueue(shardFor(), authenticatedEnvDev.id, 1);
      expect(await on.redis.zscore(ckVtimeKey, heavy)).toBe("5");
    } finally {
      await off.quit();
      await on.quit();
    }
  });

  redisTest("an immediate serve charges from its parked tag", async ({ redisContainer }) => {
    const { on, off, heavy, ckVtimeKey, ckVtimeIdleKey } = await setup(redisContainer);
    try {
      // maxCount 2 leaves pass 2 a slot, so heavy is served rather than just registered.
      await on.testDequeueFromMasterQueue(shardFor(), authenticatedEnvDev.id, 2);
      // Served from 5 and charged one quantum, then drained again and re-parked at 6.
      // Taking the floor as its tag would have re-parked 1 over the credit it earned.
      expect(await on.redis.zscore(ckVtimeKey, heavy)).toBeNull();
      expect(await on.redis.zscore(ckVtimeIdleKey, heavy)).toBe("6");
    } finally {
      await off.quit();
      await on.quit();
    }
  });
});
