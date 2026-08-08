import { createRedisClient } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { Decimal } from "@trigger.dev/database";
import { setTimeout as sleep } from "node:timers/promises";
import { describe } from "node:test";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";

// Multi-consumer / multi-shard correctness for CK virtual-time scheduling, plus
// an op-count budget pinning the per-dequeue overhead of the vtime path.
//
// The correctness argument for concurrent consumers is that every ckVtime /
// ckIndex mutation happens inside a single Lua script and Redis serialises
// scripts. These tests check the scripts do not assume any cross-call state:
// two RunQueue instances hammering the same keyspace must still serve every
// message exactly once, never rewind a tag, and leave the vtime state clean.

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 25,
  logger: new Logger("RunQueue", "warn"),
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

function createQueue(redisContainer: any, keyPrefix: string, vtimeEnabled: boolean) {
  return new RunQueue({
    ...testOptions,
    // These tests drive every dequeue themselves (testDequeueFromMasterQueue +
    // skipDequeueProcessing). The ONLY concurrency is the explicit consumer
    // loops below, so the autonomous master-queue consumers and the background
    // worker must stay off in every instance.
    masterQueueConsumersDisabled: true,
    workerOptions: { disabled: true },
    ckVirtualTimeScheduling: {
      enabled: vtimeEnabled,
    },
    queueSelectionStrategy: new FairQueueSelectionStrategy({
      redis: {
        keyPrefix,
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      },
      keys: testOptions.keys,
    }),
    redis: {
      keyPrefix,
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
    },
  });
}

function makeMessage(overrides: Partial<InputPayload> = {}): InputPayload {
  return {
    runId: "r1",
    taskIdentifier: "task/my-task",
    orgId: "o1234",
    projectId: "p1234",
    environmentId: "e1234",
    environmentType: "DEVELOPMENT",
    queue: "task/my-task",
    timestamp: Date.now(),
    attempt: 0,
    ...overrides,
  };
}

// The ckVtime/ckIndex member for a variant is the fully-qualified variant queue
// key (org:proj:env:queue:...:ck:<ck>), which is exactly what queueKey() produces.
function variantName(ck: string): string {
  return testOptions.keys.queueKey(authenticatedEnvDev, "task/my-task", ck);
}

vi.setConfig({ testTimeout: 120_000 });

describe("CK virtual-time concurrency and op-count budget", () => {
  redisTest("two consumers, one base queue, no corruption", async ({ redisContainer }) => {
    const keyPrefix = "rq15:";
    // one instance for enqueues, two more (same Redis, same key prefix) as consumers
    const producer = createQueue(redisContainer, keyPrefix, true);
    const consumerA = createQueue(redisContainer, keyPrefix, true);
    const consumerB = createQueue(redisContainer, keyPrefix, true);
    try {
      const t0 = Date.now() - 100_000;
      const cks = ["a", "b", "c", "d", "e", "f"];
      const perKey = 30;

      const enqueuedIds = new Set<string>();
      for (const ck of cks) {
        for (let i = 0; i < perKey; i++) {
          const runId = `r-${ck}-${i}`;
          enqueuedIds.add(runId);
          await producer.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({ runId, concurrencyKey: ck, timestamp: t0 + i }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }
      }

      const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
      const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(variantName("a"));
      const ckVtimeFloorKey = testOptions.keys.ckVtimeFloorKeyFromQueue(variantName("a"));

      // shared across both consumer loops: messageId -> times served
      const serveCounts = new Map<string, number>();
      const floorSamples: number[] = [];
      let floorRewind: { consumer: string; prev: number; next: number } | undefined;

      const runConsumer = async (name: string, queue: RunQueue) => {
        let prevFloor = 0;
        let iterations = 0;
        while (serveCounts.size < enqueuedIds.size) {
          iterations++;
          if (iterations > 600) {
            throw new Error(
              `consumer ${name}: iteration cap hit with ${serveCounts.size}/${enqueuedIds.size} unique messages served`
            );
          }

          const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 5);

          // record serves immediately, so the exactly-once bookkeeping covers
          // messages currently held by the other consumer too
          for (const m of messages) {
            serveCounts.set(m.messageId, (serveCounts.get(m.messageId) ?? 0) + 1);
          }

          if (messages.length === 0) {
            // nothing servable right now (the other consumer holds the slots);
            // yield so its hold can elapse
            await sleep(2);
          } else {
            // short hold before acking, so the two loops genuinely overlap
            await sleep(3);
            for (const m of messages) {
              await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, m.messageId, {
                skipDequeueProcessing: true,
              });
            }
          }

          // sample the floor between iterations: it must never decrease
          const floor = Number((await queue.redis.get(ckVtimeFloorKey)) ?? "0");
          if (floor < prevFloor && !floorRewind) {
            floorRewind = { consumer: name, prev: prevFloor, next: floor };
          }
          prevFloor = floor;
          floorSamples.push(floor);
        }
      };

      await Promise.all([runConsumer("A", consumerA), runConsumer("B", consumerB)]);

      // exactly once: the union of served IDs equals the enqueued set, no duplicates
      const duplicates = [...serveCounts.entries()].filter(([, count]) => count > 1);
      expect(duplicates).toEqual([]);
      expect(serveCounts.size).toBe(enqueuedIds.size);
      expect(new Set(serveCounts.keys())).toEqual(enqueuedIds);

      // the floor never rewound in either consumer's sample sequence
      expect(floorRewind).toBeUndefined();

      // after drain: every variant was GC'd from ckVtime..
      expect(await consumerA.redis.zcard(ckVtimeKey)).toBe(0);
      // ..and the floor sits at the max it ever reached
      const finalFloor = Number((await consumerA.redis.get(ckVtimeFloorKey)) ?? "0");
      expect(finalFloor).toBe(Math.max(finalFloor, ...floorSamples));
    } finally {
      await producer.quit();
      await consumerA.quit();
      await consumerB.quit();
    }
  });

  redisTest("concurrent enqueue during dequeue cannot rewind a tag", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, "rq16:", true);
    try {
      const t0 = Date.now() - 100_000;

      // hot backlog large enough that it never drains (so it is never GC'd and
      // re-registered, keeping the ZSCORE comparison meaningful), plus a
      // competitor key so hot is not the only candidate
      for (let i = 0; i < 12; i++) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: `r-hot-${i}`, concurrencyKey: "hot", timestamp: t0 + i }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
      }
      for (let i = 0; i < 30; i++) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({
            runId: `r-cold-${i}`,
            concurrencyKey: "cold",
            timestamp: t0 + i,
          }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
      }

      const hotVariant = variantName("hot");
      const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(hotVariant);
      const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);

      // enqueue registered hot at the initial floor
      let prevTag = Number(await queue.redis.zscore(ckVtimeKey, hotVariant));
      expect(prevTag).toBe(0);

      let extra = 0;
      for (let round = 0; round < 12; round++) {
        // enqueues on the hot key racing a dequeue batch: the enqueue script's
        // ZADD NX registration must never rewind the tag the dequeue script is
        // advancing (advance-only writes)
        const [, messages] = await Promise.all([
          (async () => {
            for (let j = 0; j < 2; j++) {
              await queue.enqueueMessage({
                env: authenticatedEnvDev,
                message: makeMessage({
                  runId: `r-hot-extra-${extra++}`,
                  concurrencyKey: "hot",
                  timestamp: t0 + 1000 + round,
                }),
                workerQueue: authenticatedEnvDev.id,
                skipDequeueProcessing: true,
              });
            }
          })(),
          queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 3),
        ]);

        for (const m of messages) {
          await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, m.messageId, {
            skipDequeueProcessing: true,
          });
        }

        const tag = await queue.redis.zscore(ckVtimeKey, hotVariant);
        // never drained, so never GC'd
        expect(tag, `round ${round}: hot variant missing from ckVtime`).not.toBeNull();
        expect(Number(tag), `round ${round}: tag rewound`).toBeGreaterThanOrEqual(prevTag);
        prevTag = Number(tag);
      }

      // hot was actually served along the way (the invariant wasn't vacuous)
      expect(prevTag).toBeGreaterThan(0);
    } finally {
      await queue.quit();
    }
  });

  redisTest("op-count budget: vtime dequeue overhead is bounded", async ({ redisContainer }) => {
    const maxCount = 5;
    const dequeueCalls = 50;
    const cks = ["a", "b", "c", "d", "e", "f"];
    const perKey = 30;

    // second plain ioredis client (no key prefix) for CONFIG RESETSTAT / INFO.
    // Redis command stats are server-wide, so each phase resets them after its
    // enqueues and reads them right after its 50th dequeue call.
    const statsClient = createRedisClient({
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
    });

    // Runs one phase: identical data under a fresh keyspace, then 50 identical
    // dequeue calls (ack immediately, so env concurrency never gates a serve
    // and both phases fully drain the same 180 messages inside the window).
    const runPhase = async (keyPrefix: string, vtimeEnabled: boolean) => {
      const queue = createQueue(redisContainer, keyPrefix, vtimeEnabled);
      try {
        const t0 = Date.now() - 100_000;
        for (const ck of cks) {
          for (let i = 0; i < perKey; i++) {
            await queue.enqueueMessage({
              env: authenticatedEnvDev,
              message: makeMessage({
                runId: `r-${ck}-${i}`,
                concurrencyKey: ck,
                timestamp: t0 + i,
              }),
              workerQueue: authenticatedEnvDev.id,
              skipDequeueProcessing: true,
            });
          }
        }

        const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);

        await statsClient.call("CONFIG", "RESETSTAT");

        let served = 0;
        for (let call = 0; call < dequeueCalls; call++) {
          const messages = await queue.testDequeueFromMasterQueue(
            shard,
            authenticatedEnvDev.id,
            maxCount
          );
          served += messages.length;
          for (const m of messages) {
            await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, m.messageId, {
              skipDequeueProcessing: true,
            });
          }
        }

        const info = await statsClient.info("commandstats");
        return { served, totalCalls: totalCommandCalls(info) };
      } finally {
        await queue.quit();
      }
    };

    try {
      const off = await runPhase("rq17off:", false);
      const on = await runPhase("rq17on:", true);

      // both phases did identical work: the full 180 messages served and acked
      expect(off.served).toBe(cks.length * perKey);
      expect(on.served).toBe(cks.length * perKey);

      // Per dequeue call the vtime path adds at worst 8 fixed ops: GET floor,
      // ZRANGE min, ZRANGE window, the pass-2 ZRANGEBYSCORE, the pass-2
      // discovery ZADD, SET floor, EXISTS ckVtime, EXPIRE ckVtime, plus per
      // serve one ZSCORE and one ZADD. The discovery ZADD is variadic, so it
      // stays a single op however many variants one call registers.
      const budget = dequeueCalls * (8 + 2 * maxCount);
      expect(
        on.totalCalls,
        `on_total ${on.totalCalls} exceeds off_total ${off.totalCalls} + budget ${budget}`
      ).toBeLessThanOrEqual(off.totalCalls + budget);
    } finally {
      await statsClient.quit();
    }
  });
});

// Sums calls= across every cmdstat_ line of INFO commandstats. Includes
// commands executed from inside Lua scripts, which is exactly what we want:
// the vtime overhead lives in the dequeue script body.
function totalCommandCalls(info: string): number {
  let total = 0;
  for (const line of info.split("\n")) {
    const match = line.match(/^cmdstat_[^:]+:calls=(\d+)/);
    if (match) {
      total += Number(match[1]);
    }
  }
  return total;
}
