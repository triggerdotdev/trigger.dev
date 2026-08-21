import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { Decimal } from "@trigger.dev/database";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";

// Two registration paths nothing else covers.
//
// The TTL enqueue command carries its own copy of the registration block, and the only way
// into it is enqueueing a run that has a TTL while the flag is on.
//
// The quantum is the other: everything else runs at the default of 1, so no tag anywhere
// in the suite has a fractional part and the weight dimension goes unexercised.

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

function createQueue(redisContainer: any, opts: { quantum?: number; ttl?: boolean } = {}): any {
  const redis = {
    keyPrefix: "runqueue:test:",
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
  };
  return new RunQueue({
    ...testOptions,
    masterQueueConsumersDisabled: true,
    workerOptions: { disabled: true },
    ckVirtualTimeScheduling: {
      enabled: true,
      ...(opts.quantum ? { quantum: opts.quantum } : {}),
    },
    ...(opts.ttl
      ? {
          ttlSystem: {
            consumersDisabled: true,
            workerQueueSuffix: "ttlworker",
            workerItemsSuffix: "ttlworkeritems",
          },
        }
      : {}),
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
const score = async (queue: any, key: string, member: string) => {
  const raw = await queue.redis.zscore(key, member);
  return raw === null ? null : Number(raw);
};

describe("CK vtime: registration paths the core tests do not reach", () => {
  redisTest("a run with a TTL registers and stacks like any other", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, { ttl: true });
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

      const heavy = variantName("heavy");
      const fresh = variantName("fresh");
      const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(heavy);
      const ckVtimeIdleKey = testOptions.keys.ckVtimeIdleKeyFromQueue(heavy);

      await queue.testDequeueFromMasterQueue(shardFor(), authenticatedEnvDev.id, 1);
      expect(await score(queue, ckVtimeKey, heavy)).toBe(1);

      // Brand new, and arriving with a TTL attached, so this goes through the second copy
      // of the registration block. It has to land behind the leader, not at the floor.
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({
          runId: "f0",
          concurrencyKey: "fresh",
          timestamp: t0 + 10,
          ttlExpiresAt: Date.now() + 600_000,
        }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });
      expect(await score(queue, ckVtimeKey, fresh)).toBe(2);

      // And the credit round trip, on the same copy: drain it, then bring it back.
      await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, "f0", {
        skipDequeueProcessing: true,
      });
      expect(await score(queue, ckVtimeIdleKey, fresh)).toBe(2);

      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({
          runId: "f1",
          concurrencyKey: "fresh",
          timestamp: t0 + 11,
          ttlExpiresAt: Date.now() + 600_000,
        }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });
      expect(await score(queue, ckVtimeKey, fresh)).toBe(2);
    } finally {
      await queue.quit();
    }
  });

  redisTest("a fractional quantum survives the trip into Redis", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, { quantum: 0.3 });
    try {
      const t0 = Date.now() - 100_000;

      for (let i = 0; i < 3; i++) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: `h${i}`, concurrencyKey: "heavy", timestamp: t0 + i }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
      }

      const heavy = variantName("heavy");
      const fresh = variantName("fresh");
      const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(heavy);

      // Two serves at 0.3 each. An integer quantum would leave this at 2, and a tag
      // truncated on its way into Redis would leave it at 0.
      for (let i = 0; i < 2; i++) {
        await queue.testDequeueFromMasterQueue(shardFor(), authenticatedEnvDev.id, 1);
        await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, `h${i}`, {
          skipDequeueProcessing: true,
        });
      }
      expect(await score(queue, ckVtimeKey, heavy)).toBeCloseTo(0.6, 5);

      // Arrival stacks one quantum behind the leader, and 0.9 is the value that gets lost
      // if the tag reaches Redis as a number rather than a string.
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "f0", concurrencyKey: "fresh", timestamp: t0 + 10 }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });
      expect(await score(queue, ckVtimeKey, fresh)).toBeCloseTo(0.9, 5);
    } finally {
      await queue.quit();
    }
  });
});
