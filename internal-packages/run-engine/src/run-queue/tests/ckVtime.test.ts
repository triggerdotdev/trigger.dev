import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { Decimal } from "@trigger.dev/database";
import { describe } from "node:test";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";

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

type VtimeOverrides = {
  enabled?: boolean;
  quantum?: number;
  scanWindowMultiplier?: number;
  stateTtlSeconds?: number;
};

function createQueue(redisContainer: any, vtime: VtimeOverrides = {}) {
  return new RunQueue({
    ...testOptions,
    ckVirtualTimeScheduling: {
      enabled: true,
      ...vtime,
    },
    queueSelectionStrategy: new FairQueueSelectionStrategy({
      redis: {
        keyPrefix: "runqueue:test:",
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      },
      keys: testOptions.keys,
    }),
    redis: {
      keyPrefix: "runqueue:test:",
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

const QUEUE = "task/my-task";

vi.setConfig({ testTimeout: 60_000 });

describe("CK virtual-time (SFQ) dequeue", () => {
  redisTest("vtime order beats head-timestamp order", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      const t0 = Date.now() - 100_000;

      // 30 old messages on heavy, timestamps t0..t0+29
      for (let i = 0; i < 30; i++) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: `h${i}`, concurrencyKey: "heavy", timestamp: t0 + i }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
      }
      // 3 much newer messages on light
      for (let i = 0; i < 3; i++) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: `l${i}`, concurrencyKey: "light", timestamp: t0 + 1000 }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
      }

      const heavyVariant = variantName("heavy");
      const lightVariant = variantName("light");
      const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(heavyVariant);

      // Task 4 (enqueue registration) isn't done yet; seed both variants at tag 0.
      await queue.redis.zadd(ckVtimeKey, 0, heavyVariant, 0, lightVariant);

      const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);

      const lightServedInCall: number[] = [];
      const lightSeen = new Set<string>();

      for (let call = 0; call < 3; call++) {
        const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 10);

        // At most one message per variant per call.
        const heavyCount = messages.filter((m) => m.message.concurrencyKey === "heavy").length;
        const lightCount = messages.filter((m) => m.message.concurrencyKey === "light").length;
        expect(heavyCount).toBeLessThanOrEqual(1);
        expect(lightCount).toBeLessThanOrEqual(1);

        for (const m of messages) {
          if (m.message.concurrencyKey === "light" && !lightSeen.has(m.messageId)) {
            lightSeen.add(m.messageId);
            lightServedInCall.push(call);
          }
          // ack to free concurrency between calls
          await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, m.messageId, {
            skipDequeueProcessing: true,
          });
        }
      }

      // All 3 light messages served within the first 3 calls (age order alone
      // would have drained the 30 heavy messages first).
      expect(lightSeen.size).toBe(3);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "vtime order wins over older head when maxCount forces a choice",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const t0 = Date.now() - 100_000;

        // Old messages on heavy: age order strictly favours heavy.
        for (let i = 0; i < 5; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({ runId: `h${i}`, concurrencyKey: "heavy", timestamp: t0 + i }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }
        // Newer messages on light (two, so light isn't GC'd after its serve).
        for (let i = 0; i < 2; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `l${i}`,
              concurrencyKey: "light",
              timestamp: t0 + 1000,
            }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        const heavyVariant = variantName("heavy");
        const lightVariant = variantName("light");
        const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(heavyVariant);

        // Seed vtime the OPPOSITE way to age order: heavy has the HIGH tag,
        // light the LOW tag.
        await queue.redis.zadd(ckVtimeKey, 10, heavyVariant, 0, lightVariant);

        const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);

        // maxCount 1 with two ready variants: ordering alone decides who is
        // served. Age order (the old command) would pick heavy's older head;
        // vtime rank must pick light's lower tag.
        const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 1);

        expect(messages.length).toBe(1);
        expect(messages[0]!.message.concurrencyKey).toBe("light");

        // Light's tag advanced by the quantum (=1); heavy's is untouched.
        const lightTag = Number(await queue.redis.zscore(ckVtimeKey, lightVariant));
        const heavyTag = Number(await queue.redis.zscore(ckVtimeKey, heavyVariant));
        expect(lightTag).toBe(1);
        expect(heavyTag).toBe(10);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("tags advance per serve within one batched call", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      const t0 = Date.now() - 100_000;
      const cks = ["a", "b", "c", "d", "e"];

      // Two messages per variant so a single serve doesn't drain (and GC) it,
      // letting us observe the advanced tag afterwards.
      for (const ck of cks) {
        for (let i = 0; i < 2; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({ runId: `r-${ck}-${i}`, concurrencyKey: ck, timestamp: t0 + i }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }
      }

      const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(variantName("a"));
      const seedArgs: (string | number)[] = [];
      for (const ck of cks) {
        seedArgs.push(0, variantName(ck));
      }
      await queue.redis.zadd(ckVtimeKey, ...(seedArgs as [number, string]));

      const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
      const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 5);

      expect(messages.length).toBe(5);

      for (const ck of cks) {
        const score = await queue.redis.zscore(ckVtimeKey, variantName(ck));
        expect(Number(score)).toBe(1);
      }
    } finally {
      await queue.quit();
    }
  });

  redisTest("floor is monotonic and read-repairs", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      const t0 = Date.now() - 100_000;
      const cks = ["a", "b"];

      // enough messages per variant to keep serving for many calls
      for (const ck of cks) {
        for (let i = 0; i < 25; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({ runId: `r-${ck}-${i}`, concurrencyKey: ck, timestamp: t0 + i }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }
      }

      const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(variantName("a"));
      const ckVtimeFloorKey = testOptions.keys.ckVtimeFloorKeyFromQueue(variantName("a"));
      await queue.redis.zadd(ckVtimeKey, 0, variantName("a"), 0, variantName("b"));

      const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);

      let prevFloor = 0;
      for (let call = 0; call < 20; call++) {
        const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 2);
        for (const m of messages) {
          await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, m.messageId, {
            skipDequeueProcessing: true,
          });
        }
        const floor = Number((await queue.redis.get(ckVtimeFloorKey)) ?? "0");
        expect(floor).toBeGreaterThanOrEqual(prevFloor);
        prevFloor = floor;
      }

      // Final settle: gate both variants (limit 1 + an occupied slot) so nothing
      // is served (no advance), and the floor read-repairs up to the current min tag.
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, QUEUE, 1);
      for (const ck of cks) {
        await queue.redis.sadd(
          testOptions.keys.queueCurrentConcurrencyKeyFromQueue(variantName(ck)),
          "occupant"
        );
      }
      await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 2);

      const floorAfter = Number((await queue.redis.get(ckVtimeFloorKey)) ?? "0");
      expect(floorAfter).toBeGreaterThanOrEqual(prevFloor);

      const minEntry = await queue.redis.zrange(ckVtimeKey, 0, 0, "WITHSCORES");
      const minTag = Number(minEntry[1]);
      expect(floorAfter).toBe(minTag);
      expect(floorAfter).toBeGreaterThan(10);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "new key initialises at the floor, not zero and not behind the backlog",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const t0 = Date.now() - 100_000;
        const cks = ["a", "b"];

        for (const ck of cks) {
          for (let i = 0; i < 25; i++) {
            await queue.enqueueMessage({
              env: authenticatedEnvDev,
              message: makeMessage({ runId: `r-${ck}-${i}`, concurrencyKey: ck, timestamp: t0 + i }),
              workerQueue: authenticatedEnvDev.id,
              skipDequeueProcessing: true,
            });
          }
        }

        const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(variantName("a"));
        const ckVtimeFloorKey = testOptions.keys.ckVtimeFloorKeyFromQueue(variantName("a"));
        await queue.redis.zadd(ckVtimeKey, 0, variantName("a"), 0, variantName("b"));

        const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);

        // Drive tags up to ~20.
        for (let call = 0; call < 20; call++) {
          const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 2);
          for (const m of messages) {
            await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, m.messageId, {
              skipDequeueProcessing: true,
            });
          }
        }

        const floor = Number((await queue.redis.get(ckVtimeFloorKey)) ?? "0");
        expect(floor).toBeGreaterThan(10);

        // Register a fresh variant at the current floor (ZADD NX simulates
        // enqueue-time registration, which is a later task).
        const freshVariant = variantName("fresh");
        // two messages so the fresh variant isn't GC'd on its first serve
        for (let i = 0; i < 2; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({ runId: `r-fresh-${i}`, concurrencyKey: "fresh", timestamp: t0 + i }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }
        await queue.redis.zadd(ckVtimeKey, "NX", floor, freshVariant);

        const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 10);
        const served = messages.some((m) => m.message.concurrencyKey === "fresh");
        expect(served).toBe(true);

        const freshTag = Number(await queue.redis.zscore(ckVtimeKey, freshVariant));
        // initialised at the floor and advanced by quantum (=1), not stuck at 1
        expect(freshTag).toBe(floor + 1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("no service, no advance", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      const t0 = Date.now() - 100_000;

      // ck:a has messages but its concurrency slot will be occupied
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r-a", concurrencyKey: "a", timestamp: t0 }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });
      for (const ck of ["b", "c"]) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: `r-${ck}`, concurrencyKey: ck, timestamp: t0 }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
      }

      const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(variantName("a"));
      await queue.redis.zadd(
        ckVtimeKey,
        0,
        variantName("a"),
        0,
        variantName("b"),
        0,
        variantName("c")
      );

      // base queue concurrency limit of 1
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, QUEUE, 1);

      // occupy ck:a's single slot (equivalent to a prior dequeue-without-ack)
      await queue.redis.sadd(
        testOptions.keys.queueCurrentConcurrencyKeyFromQueue(variantName("a")),
        "occupant"
      );

      const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
      const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 10);

      const servedCks = messages.map((m) => m.message.concurrencyKey);
      expect(servedCks).not.toContain("a");
      expect(servedCks).toContain("b");
      expect(servedCks).toContain("c");

      // ck:a's tag is unchanged (never served)
      const aTag = Number(await queue.redis.zscore(ckVtimeKey, variantName("a")));
      expect(aTag).toBe(0);
    } finally {
      await queue.quit();
    }
  });

  redisTest("GC on empty variant removes it from ckIndex and ckVtime", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      const t0 = Date.now() - 100_000;

      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r-a", concurrencyKey: "a", timestamp: t0 }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });
      // second variant so ckVtime/ckIndex don't fully disappear, keeping the test focused
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r-b", concurrencyKey: "b", timestamp: t0 }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });

      const aVariant = variantName("a");
      const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(aVariant);
      const ckIndexKey = testOptions.keys.ckIndexKeyFromQueue(aVariant);
      await queue.redis.zadd(ckVtimeKey, 0, aVariant, 0, variantName("b"));

      const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
      const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 10);
      expect(messages.some((m) => m.message.concurrencyKey === "a")).toBe(true);

      const inVtime = await queue.redis.zscore(ckVtimeKey, aVariant);
      const inIndex = await queue.redis.zscore(ckIndexKey, aVariant);
      expect(inVtime).toBeNull();
      expect(inIndex).toBeNull();
    } finally {
      await queue.quit();
    }
  });

  redisTest("TTL is set and refreshed on ckVtime and ckVtimeFloor", async ({ redisContainer }) => {
    const stateTtlSeconds = 3600;
    const queue = createQueue(redisContainer, { stateTtlSeconds });
    try {
      const t0 = Date.now() - 100_000;

      // two messages on one variant so ckVtime survives (not GC'd) after a serve
      for (let i = 0; i < 2; i++) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: `r-a-${i}`, concurrencyKey: "a", timestamp: t0 + i }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
      }

      const aVariant = variantName("a");
      const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(aVariant);
      const ckVtimeFloorKey = testOptions.keys.ckVtimeFloorKeyFromQueue(aVariant);
      await queue.redis.zadd(ckVtimeKey, 0, aVariant);

      const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
      await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 1);

      const vtimeTtl = await queue.redis.pttl(ckVtimeKey);
      const floorTtl = await queue.redis.pttl(ckVtimeFloorKey);

      expect(vtimeTtl).toBeGreaterThan(0);
      expect(vtimeTtl).toBeLessThanOrEqual(stateTtlSeconds * 1000);
      expect(floorTtl).toBeGreaterThan(0);
      expect(floorTtl).toBeLessThanOrEqual(stateTtlSeconds * 1000);
    } finally {
      await queue.quit();
    }
  });

  redisTest("pass 2 fill serves unregistered variants and registers them", async ({
    redisContainer,
  }) => {
    const queue = createQueue(redisContainer);
    try {
      const t0 = Date.now() - 100_000;

      // Enqueue on a variant but do NOT register it in ckVtime (simulating an
      // enqueue from old code / before Task 4). Two messages so the variant
      // survives its first serve and we can observe it was registered.
      for (let i = 0; i < 2; i++) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: `r-a-${i}`, concurrencyKey: "a", timestamp: t0 + i }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
      }

      const aVariant = variantName("a");
      const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(aVariant);
      // ensure no ckVtime entry exists for it
      await queue.redis.zrem(ckVtimeKey, aVariant);

      const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
      const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 10);

      expect(messages.some((m) => m.message.concurrencyKey === "a")).toBe(true);

      const tag = await queue.redis.zscore(ckVtimeKey, aVariant);
      expect(tag).not.toBeNull();
    } finally {
      await queue.quit();
    }
  });

  redisTest("future-scheduled variants are skipped without advance", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      const t0 = Date.now() - 100_000;

      // a normal ready variant so the :ck:* wildcard is selected from the master queue
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r-now", concurrencyKey: "now", timestamp: t0 }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });
      // a future-scheduled variant
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({
          runId: "r-future",
          concurrencyKey: "future",
          timestamp: Date.now() + 60_000,
        }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });

      const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(variantName("now"));
      const futureVariant = variantName("future");
      await queue.redis.zadd(ckVtimeKey, 0, variantName("now"), 5, futureVariant);

      const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
      const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 10);

      expect(messages.some((m) => m.message.concurrencyKey === "future")).toBe(false);

      const futureTag = Number(await queue.redis.zscore(ckVtimeKey, futureVariant));
      expect(futureTag).toBe(5);
    } finally {
      await queue.quit();
    }
  });
});
