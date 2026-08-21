import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { Decimal } from "@trigger.dev/database";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";

// Devin on #4367: the gated-candidate block corrects every member of gatedPending with its
// parked idle tag once the batched ZADD NX has added at least one member, rather than only
// the members it actually added. A candidate that is already registered with an advanced
// tag can therefore have that tag overwritten by an older parked one, which rewinds its
// virtual clock and hands it a turn it has already taken.
//
// Reaching it needs the pass-1 scan to be incomplete, because that scan is the only thing
// that decides knownRegistered. It reads scanLimit entries, so a queue holding more
// variants than that pushes already-registered ones into pass 2 as if they were new.

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
    maxTimeoutInMs: 1_000,
    randomize: true,
  },
  keys: new RunQueueFullKeyProducer(),
};

const authenticatedEnvDev = {
  id: "e1234",
  type: "DEVELOPMENT" as const,
  maximumConcurrencyLimit: 100,
  concurrencyLimitBurstFactor: new Decimal(1),
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

const QUEUE = "task/my-task";

function createQueue(redisContainer: any): any {
  const redis = {
    keyPrefix: "runqueue:test:rewind:",
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
  };
  return new RunQueue({
    ...testOptions,
    masterQueueConsumersDisabled: true,
    workerOptions: { disabled: true },
    // window = 1 * 1, so scanLimit is 2 and four variants overflow it.
    ckVirtualTimeScheduling: { enabled: true, scanWindowMultiplier: 1 },
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

describe("CK vtime: the gated batch must not rewind a live tag", () => {
  redisTest("a stale parked tag cannot undercut an advanced one", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      const t0 = Date.now() - 100_000;

      // Head age decides pass 2's order, so victim is visited first.
      const cks = ["victim", "wnew", "aa", "bb"];
      for (let i = 0; i < cks.length; i++) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: `r-${cks[i]}`, concurrencyKey: cks[i], timestamp: t0 + i }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
      }

      const victim = variantName("victim");
      const wnew = variantName("wnew");
      const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(victim);
      const ckVtimeIdleKey = testOptions.keys.ckVtimeIdleKeyFromQueue(victim);

      // aa and bb hold the two scan slots, so victim falls outside the scan and reaches
      // pass 2 with knownRegistered false even though it is registered.
      await queue.redis.zadd(ckVtimeKey, 0, variantName("aa"), 1, variantName("bb"), 10, victim);
      // wnew is genuinely unregistered, so the batched ZADD NX adds one member and the
      // correction loop runs at all.
      await queue.redis.zrem(ckVtimeKey, wnew);
      // Left behind by an earlier drain: the enqueue path reads this to restore credit but
      // never deletes it, and it is only reaped once the floor climbs past it.
      await queue.redis.zadd(ckVtimeIdleKey, 5, victim);

      // Every variant parked at its per-key ceiling, so pass 1 serves nothing and pass 2
      // reaches the gated block.
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, QUEUE, 1);
      for (const ck of cks) {
        await queue.redis.sadd(
          testOptions.keys.queueCurrentConcurrencyKeyFromQueue(variantName(ck)),
          "occupant"
        );
      }

      const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
      const served = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 1);
      expect(served.length).toBe(0);

      // wnew joined at the floor, which is the whole point of the block.
      expect(await queue.redis.zscore(ckVtimeKey, wnew)).toBe("0");
      // victim spent its credit already and must keep its advanced tag. Rewinding it to
      // the parked 5 would put it ahead of variants that are genuinely due.
      expect(await queue.redis.zscore(ckVtimeKey, victim)).toBe("10");
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "a variant registering here still gets its parked tag back",
    async ({ redisContainer }) => {
      // The other half of the same branch. Deleting the idle correction outright used to
      // leave every vtime suite green, so the rewind guard was pinned while the behaviour it
      // guards was not.
      const queue = createQueue(redisContainer);
      try {
        const t0 = Date.now() - 100_000;

        const cks = ["returner", "aa", "bb"];
        for (let i = 0; i < cks.length; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `r-${cks[i]}`,
              concurrencyKey: cks[i],
              timestamp: t0 + i,
            }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        const returner = variantName("returner");
        const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(returner);
        const ckVtimeIdleKey = testOptions.keys.ckVtimeIdleKeyFromQueue(returner);

        await queue.redis.zadd(ckVtimeKey, 0, variantName("aa"), 1, variantName("bb"));
        await queue.redis.zrem(ckVtimeKey, returner);
        await queue.redis.zadd(ckVtimeIdleKey, 5, returner);

        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, QUEUE, 1);
        for (const ck of cks) {
          await queue.redis.sadd(
            testOptions.keys.queueCurrentConcurrencyKeyFromQueue(variantName(ck)),
            "occupant"
          );
        }

        const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
        await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 1);

        // Registering at the floor instead would hand it a turn it already spent.
        expect(await queue.redis.zscore(ckVtimeKey, returner)).toBe("5");
      } finally {
        await queue.quit();
      }
    }
  );
});
