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

// vtime: overrides merged into an enabled ckVirtualTimeScheduling option, or
// null to omit the option entirely (flag off, the production default).
function createQueue(redisContainer: any, vtime: VtimeOverrides | null = {}) {
  return new RunQueue({
    ...testOptions,
    // These tests drive every op themselves (testDequeueFromMasterQueue + skipDequeueProcessing),
    // so the autonomous master-queue consumers and background worker must not race them.
    masterQueueConsumersDisabled: true,
    workerOptions: { disabled: true },
    ...(vtime === null
      ? {}
      : {
          ckVirtualTimeScheduling: {
            enabled: true,
            ...vtime,
          },
        }),
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

      // Explicit seed is redundant now that enqueue registers variants at the
      // floor itself; kept as a belt-and-braces fixture.
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

      // Final settle: gate both variants (limit 1 + an occupied slot) so nothing is served.
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, QUEUE, 1);
      for (const ck of cks) {
        await queue.redis.sadd(
          testOptions.keys.queueCurrentConcurrencyKeyFromQueue(variantName(ck)),
          "occupant"
        );
      }
      await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 2);

      const minEntry = await queue.redis.zrange(ckVtimeKey, 0, 0, "WITHSCORES");
      const minTag = Number(minEntry[1]);
      expect(minTag).toBeGreaterThan(prevFloor);

      // A call that serves nothing persists nothing. The read-repair to the min tag is
      // recomputed from ckVtime at the top of every call, so leaving it unwritten here
      // costs nothing and keeps an idle poll free of writes.
      const floorWhileGated = Number((await queue.redis.get(ckVtimeFloorKey)) ?? "0");
      expect(floorWhileGated).toBe(prevFloor);

      // Free a slot: the next serving call persists the repaired floor, so the repair
      // itself is intact, it is only the write that waits for a serve.
      for (const ck of cks) {
        await queue.redis.srem(
          testOptions.keys.queueCurrentConcurrencyKeyFromQueue(variantName(ck)),
          "occupant"
        );
      }
      await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 2);

      const floorAfter = Number((await queue.redis.get(ckVtimeFloorKey)) ?? "0");
      expect(floorAfter).toBeGreaterThanOrEqual(minTag);
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

        const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(variantName("a"));
        const ckVtimeFloorKey = testOptions.keys.ckVtimeFloorKeyFromQueue(variantName("a"));
        // No direct ZADD seeding: the enqueues above register a and b at the
        // initial floor (0) themselves.

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

        // A fresh variant registers itself at the current floor via the
        // enqueue-time registration (ZADD NX in the enqueue script).
        const freshVariant = variantName("fresh");
        // two messages so the fresh variant isn't GC'd on its first serve
        for (let i = 0; i < 2; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `r-fresh-${i}`,
              concurrencyKey: "fresh",
              timestamp: t0 + i,
            }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

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

  // H1 regression: the floor key must not be allowed to expire while ckVtime
  // survives. Before the fix, only the dequeue command refreshed the floor
  // key's TTL, so a dequeue-quiescent + enqueue-active base queue let the floor
  // key expire underneath a live ckVtime; a brand-new variant then read a
  // missing floor as 0 and jumped ahead of the whole established backlog. The
  // enqueue/nack registration paths now refresh the floor key TTL too.
  redisTest(
    "enqueue refreshes the floor key TTL and a new variant registers at the current floor",
    async ({ redisContainer }) => {
      const stateTtlSeconds = 3600;
      const queue = createQueue(redisContainer, { stateTtlSeconds });
      try {
        const t0 = Date.now() - 100_000;
        const cks = ["a", "b"];

        for (const ck of cks) {
          for (let i = 0; i < 25; i++) {
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

        const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(variantName("a"));
        const ckVtimeFloorKey = testOptions.keys.ckVtimeFloorKeyFromQueue(variantName("a"));
        const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);

        // Drive tags and the floor above 0 with a run of serves.
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
        expect(await queue.redis.exists(ckVtimeKey)).toBe(1);

        // Simulate the floor key's TTL decaying toward expiry while dequeues are
        // quiescent. Without the fix, only a dequeue would ever bump it back.
        await queue.redis.pexpire(ckVtimeFloorKey, 2_000);

        // WITHOUT dequeuing, enqueue several more messages on an existing
        // variant. The enqueue registration path must refresh the floor key TTL.
        for (let i = 0; i < 5; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `r-a-more-${i}`,
              concurrencyKey: "a",
              timestamp: t0 + 500 + i,
            }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        // The floor key TTL was pushed back up to (about) stateTtl, well above
        // the 2s decay we forced.
        const floorPttl = await queue.redis.pttl(ckVtimeFloorKey);
        expect(floorPttl).toBeGreaterThan(2_000);
        expect(floorPttl).toBeLessThanOrEqual(stateTtlSeconds * 1000);

        // Enqueue-only activity does not move the floor value itself.
        const floorAfter = Number((await queue.redis.get(ckVtimeFloorKey)) ?? "0");
        expect(floorAfter).toBe(floor);

        // A brand-new variant enqueued now registers at the CURRENT floor, so it
        // cannot leapfrog the established backlog back to 0.
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: "r-fresh", concurrencyKey: "fresh", timestamp: t0 }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
        const freshTag = Number(await queue.redis.zscore(ckVtimeKey, variantName("fresh")));
        expect(freshTag).toBe(floor);
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

  redisTest(
    "GC on empty variant removes it from ckIndex and ckVtime",
    async ({ redisContainer }) => {
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
    }
  );

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

  redisTest(
    "pass 2 fill serves unregistered variants and registers them",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const t0 = Date.now() - 100_000;

        // Enqueue on a variant but do NOT register it in ckVtime (simulating an
        // enqueue from old code that predates enqueue-time registration, e.g.
        // during a rolling deploy). Two messages so the variant survives its
        // first serve and we can observe it was registered.
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
    }
  );

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

      // Not served, so not charged a quantum. It stays registered: pass 1 is the only
      // path that can reach it, so de-registering it would strand it while pass 1 is
      // busy. It no longer holds the floor down, which the floor tests cover.
      const futureTag = Number(await queue.redis.zscore(ckVtimeKey, futureVariant));
      expect(futureTag).toBe(5);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "a variant whose backoff elapses is served even while pass 1 stays full",
    { timeout: 120_000 },
    async ({ redisContainer }) => {
      // Pass 1 is the only path that reads ckVtime, and pass 2 is skipped whenever pass 1
      // fills the batch. Dropping a not-ready variant from ckVtime therefore stranded it
      // for as long as any other key kept the batch full: measured at over 2000 calls.
      const queue = createQueue(redisContainer);
      try {
        const t0 = Date.now() - 100_000;

        for (let k = 0; k < 3; k++) {
          for (let i = 0; i < 40; i++) {
            await queue.enqueueMessage({
              env: authenticatedEnvDev,
              message: makeMessage({
                runId: `b${k}-${i}`,
                concurrencyKey: `b${k}`,
                timestamp: t0 + i,
              }),
              workerQueue: authenticatedEnvDev.id,
              skipDequeueProcessing: true,
            });
          }
        }
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({
            runId: "stalled-1",
            concurrencyKey: "stalled",
            timestamp: Date.now() + 400,
          }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });

        const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
        const drain = async (calls: number) => {
          let servedStalled = false;
          for (let call = 0; call < calls; call++) {
            const messages = await queue.testDequeueFromMasterQueue(
              shard,
              authenticatedEnvDev.id,
              1
            );
            for (const m of messages) {
              if (m.message.concurrencyKey === "stalled") servedStalled = true;
              await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, m.messageId, {
                skipDequeueProcessing: true,
              });
            }
          }
          return servedStalled;
        };

        // Let the incumbents advance so the stalled variant holds the lowest tag, which is
        // what pulls it into the pass-1 window and onto the skip path.
        await drain(6);
        await new Promise((resolve) => setTimeout(resolve, 700));

        expect(await drain(60)).toBe(true);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "a variant at its concurrency ceiling does not pin the floor",
    async ({ redisContainer }) => {
      // A saturated variant stops advancing but keeps its tag, which used to hold the
      // floor down for everyone arriving later.
      const queue = createQueue(redisContainer);
      try {
        const t0 = Date.now() - 100_000;

        // Per-key ceiling of 1, well under the env limit, so hog gates on its own account
        // rather than by exhausting env capacity.
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, QUEUE, 1);

        for (let i = 0; i < 12; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({ runId: `r-hog-${i}`, concurrencyKey: "hog", timestamp: t0 + i }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }
        for (let i = 0; i < 12; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `r-busy-${i}`,
              concurrencyKey: "busy",
              timestamp: t0 + 500 + i,
            }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
        const hogVariant = variantName("hog");
        const busyVariant = variantName("busy");
        const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(busyVariant);
        const floorKey = testOptions.keys.ckVtimeFloorKeyFromQueue(busyVariant);

        // Ack only busy, so hog accumulates in-flight messages until it is gated.
        for (let call = 0; call < 10; call++) {
          const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 2);
          for (const m of messages) {
            if (m.message.concurrencyKey === "busy") {
              await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, m.messageId, {
                skipDequeueProcessing: true,
              });
            }
          }
        }

        const hogTag = Number(await queue.redis.zscore(ckVtimeKey, hogVariant));
        const busyTag = Number(await queue.redis.zscore(ckVtimeKey, busyVariant));
        const floor = Number((await queue.redis.get(floorKey)) ?? "0");

        // hog is still registered (it has ready work and will be served when a slot
        // frees), it has simply stopped advancing while saturated.
        expect(hogTag).not.toBeNaN();
        expect(busyTag).toBeGreaterThan(hogTag);

        // The floor followed the key that was actually being served, not the stalled one.
        expect(floor).toBeGreaterThan(hogTag);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "an unservable variant does not pin the floor for later arrivals",
    async ({ redisContainer }) => {
      // Regression: a variant with work but nothing ready (a nack backoff is the common
      // case) used to sit in ckVtime holding the lowest tag. The floor is the minimum
      // stored tag, so it froze at that value while served keys advanced, and because new
      // keys register at the floor, a key arriving later started far below the established
      // ones and won every pass-1 slot until it caught up. That is the starvation this
      // feature exists to prevent, inverted.
      const queue = createQueue(redisContainer);
      try {
        const t0 = Date.now() - 100_000;

        // Stalled: registered on enqueue, but its head never becomes ready during the test.
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({
            runId: "r-stalled",
            concurrencyKey: "stalled",
            timestamp: Date.now() + 60 * 60 * 1000,
          }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });

        for (let i = 0; i < 12; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `r-busy-${i}`,
              concurrencyKey: "busy",
              timestamp: t0 + i,
            }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
        for (let call = 0; call < 6; call++) {
          const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 1);
          for (const m of messages) {
            await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, m.messageId, {
              skipDequeueProcessing: true,
            });
          }
        }

        const busyVariant = variantName("busy");
        const floorKey = testOptions.keys.ckVtimeFloorKeyFromQueue(busyVariant);
        const floor = Number((await queue.redis.get(floorKey)) ?? "0");

        // The floor tracked the key that was actually being served.
        expect(floor).toBeGreaterThan(0);

        // A key arriving now joins level with the established keys rather than underneath
        // them, so it gets its turn instead of monopolising the fair pass.
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: "r-newcomer", concurrencyKey: "newcomer", timestamp: t0 }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });

        const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(busyVariant);
        const newcomerTag = Number(await queue.redis.zscore(ckVtimeKey, variantName("newcomer")));
        const busyTag = Number(await queue.redis.zscore(ckVtimeKey, busyVariant));

        expect(newcomerTag).toBe(floor);
        expect(busyTag - newcomerTag).toBeLessThanOrEqual(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "a scan filled entirely with unservable variants degrades to age order, and recovers",
    async ({ redisContainer }) => {
      // Pass 1 steps over a future-headed variant without spending a window slot, so the
      // window alone can no longer be blocked. The scan behind it is capped though, at
      // scanLimit = 2 * window (6 here), and this is the residual: with every scanned
      // position held by an unservable variant, pass 1 still serves nothing, minServableTag
      // stays nil, and the min-tag route is pinned by those same stalled tags, so the floor
      // cannot move until the block thins out.
      //
      // Two properties of that state are worth pinning down. It stays work-conserving:
      // pass 2 keeps serving in age order, which is the flag-off behaviour, so a full
      // block is a fairness degradation rather than a stall. And the recovery is bounded:
      // a key arriving mid-freeze registers at the pinned floor, below the incumbent that
      // pass 2 has been advancing, so it does lead once the block clears, but only by the
      // virtual time the incumbent accrued during the freeze.
      const queue = createQueue(redisContainer);
      try {
        const t0 = Date.now() - 100_000;

        // Names decide tie order at equal tags, and the point of the fixture is that the
        // blockers hold every scanned position: a0..a5 sort below zbusy, so the scan read
        // returns only them and zbusy is never reached.
        const blockers = ["a0", "a1", "a2", "a3", "a4", "a5"];
        for (const ck of blockers) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `r-${ck}-stalled`,
              concurrencyKey: ck,
              timestamp: Date.now() + 60 * 60 * 1000,
            }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }
        for (let i = 0; i < 80; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `r-busy-${i}`,
              concurrencyKey: "zbusy",
              timestamp: t0 + i,
            }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
        const busyVariant = variantName("zbusy");
        const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(busyVariant);
        const floorKey = testOptions.keys.ckVtimeFloorKeyFromQueue(busyVariant);

        // maxCount 1 gives window = 3, exactly the three blockers.
        const drainOne = async () => {
          const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 1);
          for (const m of messages) {
            await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, m.messageId, {
              skipDequeueProcessing: true,
            });
          }
          return messages.map((m) => m.message.concurrencyKey);
        };

        const FREEZE_CALLS = 8;
        let busyServedDuringFreeze = 0;
        for (let call = 0; call < FREEZE_CALLS; call++) {
          busyServedDuringFreeze += (await drainOne()).filter((ck) => ck === "zbusy").length;
        }

        // Work conservation held: pass 2 served on every call while pass 1 served nothing.
        expect(busyServedDuringFreeze).toBe(FREEZE_CALLS);

        // Neither floor route could move, and the blockers still hold their initial tags.
        expect(Number((await queue.redis.get(floorKey)) ?? "0")).toBe(0);
        for (const ck of blockers) {
          expect(Number(await queue.redis.zscore(ckVtimeKey, variantName(ck)))).toBe(0);
        }

        // Pass 2 advanced the incumbent's own tag even though it may not raise the floor,
        // and that gap is the debt a mid-freeze arrival gets to spend.
        const busyTagAfterFreeze = Number(await queue.redis.zscore(ckVtimeKey, busyVariant));
        expect(busyTagAfterFreeze).toBe(FREEZE_CALLS);

        for (let i = 0; i < 40; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `r-new-${i}`,
              concurrencyKey: "zznew",
              timestamp: t0 + 500 + i,
            }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        // The arrival registers at the pinned floor, so it starts below the incumbent by
        // exactly the freeze debt rather than level with it.
        expect(Number(await queue.redis.zscore(ckVtimeKey, variantName("zznew")))).toBe(0);

        // Unblock by giving each blocker ready work, which is what the elapsed-backoff
        // case looks like from the script's side. Their tags are untouched (ZADD NX).
        for (const ck of blockers) {
          for (let i = 0; i < 40; i++) {
            await queue.enqueueMessage({
              env: authenticatedEnvDev,
              message: makeMessage({
                runId: `r-${ck}-ready-${i}`,
                concurrencyKey: ck,
                timestamp: t0 + 200 + i,
              }),
              workerQueue: authenticatedEnvDev.id,
              skipDequeueProcessing: true,
            });
          }
        }

        // The unblocked cohort plus the arrival is 7 keys sitting at the floor against an
        // incumbent on FREEZE_CALLS, so levelling up costs 7 * FREEZE_CALLS serves before
        // the incumbent competes again. Drain comfortably past that rather than right on
        // the boundary, or the bound below is measuring the cutoff instead of the debt.
        const servedAfter: Record<string, number> = {};
        for (let call = 0; call < (blockers.length + 1) * FREEZE_CALLS + 60; call++) {
          for (const ck of await drainOne()) {
            servedAfter[ck] = (servedAfter[ck] ?? 0) + 1;
          }
        }

        // The incumbent is not starved by the unblocked cohort: it is served again once
        // they have spent their entitlement, well inside this many calls.
        expect(servedAfter["zbusy"] ?? 0).toBeGreaterThan(0);

        // And the mid-freeze arrival's lead over the incumbent is capped by the debt it
        // registered against, not unbounded. Slack covers tie-order and the fair share
        // both keys earn once the cohort has levelled.
        const newcomerLead = (servedAfter["zznew"] ?? 0) - (servedAfter["zbusy"] ?? 0);
        expect(newcomerLead).toBeLessThanOrEqual(FREEZE_CALLS + 3);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "enqueue registers the variant at the current floor with NX",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer);
      try {
        const t0 = Date.now() - 100_000;

        // two variants with enough messages that the drive loop never drains them
        for (const ck of ["a", "b"]) {
          for (let i = 0; i < 10; i++) {
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

        const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(variantName("a"));
        const ckVtimeFloorKey = testOptions.keys.ckVtimeFloorKeyFromQueue(variantName("a"));

        // enqueue registered both variants at the initial floor (0), before any dequeue
        expect(Number(await queue.redis.zscore(ckVtimeKey, variantName("a")))).toBe(0);
        expect(Number(await queue.redis.zscore(ckVtimeKey, variantName("b")))).toBe(0);

        const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);

        // drive the floor up to ~5 via serves
        for (let call = 0; call < 8; call++) {
          const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 2);
          for (const m of messages) {
            await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, m.messageId, {
              skipDequeueProcessing: true,
            });
          }
        }

        const floor = Number((await queue.redis.get(ckVtimeFloorKey)) ?? "0");
        expect(floor).toBeGreaterThanOrEqual(5);

        // a fresh key enqueued now lands exactly at the floor (no dequeue in between)
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: "r-fresh-0", concurrencyKey: "fresh", timestamp: t0 }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
        expect(Number(await queue.redis.zscore(ckVtimeKey, variantName("fresh")))).toBe(floor);

        // NX: enqueueing on a key whose tag is already 9 never rewinds it
        await queue.redis.zadd(ckVtimeKey, 9, variantName("nine"));
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: "r-nine-0", concurrencyKey: "nine", timestamp: t0 }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
        expect(Number(await queue.redis.zscore(ckVtimeKey, variantName("nine")))).toBe(9);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("fast path leaves vtime state untouched", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      const aVariant = variantName("a");
      const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(aVariant);

      // empty variant + free capacity: the fast path fires and skips the
      // variant zset entirely
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r-fast", concurrencyKey: "a" }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
        enableFastPath: true,
      });

      // fast-path proof: nothing landed in the variant zset..
      expect(await queue.redis.zcard(aVariant)).toBe(0);
      // ..and no vtime registration happened
      expect(await queue.redis.zscore(ckVtimeKey, aVariant)).toBeNull();

      // saturate capacity so the next enqueue takes the slow path
      await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, QUEUE, 1);
      await queue.redis.sadd(
        testOptions.keys.queueCurrentConcurrencyKeyFromQueue(aVariant),
        "occupant"
      );

      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r-slow", concurrencyKey: "a" }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
        enableFastPath: true,
      });

      // slow path taken and the variant is registered
      expect(await queue.redis.zcard(aVariant)).toBe(1);
      expect(await queue.redis.zscore(ckVtimeKey, aVariant)).not.toBeNull();
    } finally {
      await queue.quit();
    }
  });

  redisTest("nack re-registers a GC'd variant", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      const t0 = Date.now() - 100_000;

      // one message on ck:a, plenty on ck:b so serves keep flowing and the floor rises
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: makeMessage({ runId: "r-a-0", concurrencyKey: "a", timestamp: t0 }),
        workerQueue: authenticatedEnvDev.id,
        skipDequeueProcessing: true,
      });
      for (let i = 0; i < 10; i++) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: `r-b-${i}`, concurrencyKey: "b", timestamp: t0 + i }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
      }

      const aVariant = variantName("a");
      const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(aVariant);
      const ckVtimeFloorKey = testOptions.keys.ckVtimeFloorKeyFromQueue(aVariant);
      const ckIndexKey = testOptions.keys.ckIndexKeyFromQueue(aVariant);
      const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);

      // first dequeue serves a's only message: a is drained and GC'd from both indexes
      let aMessageId: string | undefined;
      const first = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 2);
      for (const m of first) {
        if (m.message.concurrencyKey === "a") {
          aMessageId = m.messageId;
        } else {
          await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, m.messageId, {
            skipDequeueProcessing: true,
          });
        }
      }
      expect(aMessageId).toBeDefined();
      expect(await queue.redis.zscore(ckVtimeKey, aVariant)).toBeNull();
      expect(await queue.redis.zscore(ckIndexKey, aVariant)).toBeNull();

      // drive the floor up via b serves
      for (let call = 0; call < 6; call++) {
        const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 1);
        for (const m of messages) {
          await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, m.messageId, {
            skipDequeueProcessing: true,
          });
        }
      }
      const floor = Number((await queue.redis.get(ckVtimeFloorKey)) ?? "0");
      expect(floor).toBeGreaterThan(0);

      // nack with an immediate retry score so the revived message is servable now
      await queue.nackMessage({
        orgId: authenticatedEnvDev.organization.id,
        messageId: aMessageId!,
        retryAt: Date.now(),
        skipDequeueProcessing: true,
      });

      // the variant is back in ckIndex AND in ckVtime at the floor
      expect(await queue.redis.zscore(ckIndexKey, aVariant)).not.toBeNull();
      expect(Number(await queue.redis.zscore(ckVtimeKey, aVariant))).toBe(floor);

      // and a subsequent dequeue serves it
      const after = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 10);
      expect(after.some((m) => m.messageId === aMessageId)).toBe(true);
    } finally {
      await queue.quit();
    }
  });

  redisTest("ckVtime membership tracks ckIndex membership", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);
    try {
      const cks = ["a", "b", "c", "d", "e", "f", "g", "h"];
      const ckIndexKey = testOptions.keys.ckIndexKeyFromQueue(variantName("a"));
      const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(variantName("a"));
      const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);

      // deterministic LCG so failures reproduce
      let seed = 123456789;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      const pick = (n: number) => Math.floor(rand() * n);

      const inFlight: string[] = [];
      let nextRun = 0;

      for (let step = 0; step < 200; step++) {
        const op = pick(4);
        let opName = "noop";

        if (op === 0) {
          opName = "enqueue";
          const ck = cks[pick(cks.length)]!;
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `r${nextRun++}`,
              concurrencyKey: ck,
              timestamp: Date.now() - 100_000,
            }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        } else if (op === 1) {
          opName = "dequeue";
          const messages = await queue.testDequeueFromMasterQueue(
            shard,
            authenticatedEnvDev.id,
            1 + pick(4)
          );
          for (const m of messages) {
            inFlight.push(m.messageId);
          }
        } else if (op === 2 && inFlight.length > 0) {
          opName = "ack";
          const [id] = inFlight.splice(pick(inFlight.length), 1);
          await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, id!, {
            skipDequeueProcessing: true,
          });
        } else if (op === 3 && inFlight.length > 0) {
          opName = "nack";
          const [id] = inFlight.splice(pick(inFlight.length), 1);
          await queue.nackMessage({
            orgId: authenticatedEnvDev.organization.id,
            messageId: id!,
            retryAt: Date.now(),
            skipDequeueProcessing: true,
          });
        }

        // closure invariant: every ckIndex member is a ckVtime member. The
        // converse may transiently not hold (stale ckVtime entries GC on scan).
        const members = await queue.redis.zrange(ckIndexKey, 0, -1);
        for (const member of members) {
          const tag = await queue.redis.zscore(ckVtimeKey, member);
          expect(
            tag,
            `step ${step} (${opName}): ${member} in ckIndex but not ckVtime`
          ).not.toBeNull();
        }
      }
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "a gated variant that was never registered still joins the fair order",
    async ({ redisContainer }) => {
      // Pass 2 marks a variant attempted before the per-key concurrency gate, and its
      // discovery step skips anything attempted, so a variant that is BOTH unregistered and
      // gated used to fall through every route: pass 1 cannot see it (no ckVtime entry),
      // pass 2 attempts it and the gate makes that a no-op, and discovery then skips it for
      // having been attempted. It stayed invisible to the fair pass for as long as the gate
      // held, on every call.
      //
      // Unregistered only happens where a variant reached ckIndex without a vtime-aware
      // write, which is the rollout case: a backlog queued before the flag went on, or an
      // enqueue from an instance that still has it off. This fixture reproduces that by
      // enqueueing through a flag-off queue and then dequeuing through a flag-on one.
      const off = createQueue(redisContainer, null);
      const on = createQueue(redisContainer);
      try {
        const t0 = Date.now() - 100_000;

        for (let i = 0; i < 2; i++) {
          await off.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `r-gated-${i}`,
              concurrencyKey: "gated",
              timestamp: t0 + i,
            }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        const gatedVariant = variantName("gated");
        const ckIndexKey = testOptions.keys.ckIndexKeyFromQueue(gatedVariant);
        const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(gatedVariant);

        // In ckIndex, and with no ckVtime entry, exactly as a pre-flag backlog looks.
        expect(await on.redis.zscore(ckIndexKey, gatedVariant)).not.toBeNull();
        expect(await on.redis.zscore(ckVtimeKey, gatedVariant)).toBeNull();

        // Hold it at its per-key ceiling so every visit hits the gate.
        await on.updateQueueConcurrencyLimits(authenticatedEnvDev, QUEUE, 1);
        await on.redis.sadd(
          testOptions.keys.queueCurrentConcurrencyKeyFromQueue(gatedVariant),
          "occupant"
        );

        const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
        const served = await on.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 1);

        // Still unservable, so nothing comes back, but the gate no longer costs it its place
        // in the fair order: it is registered at the floor and pass 1 can see it from now on.
        expect(served.length).toBe(0);
        expect(await on.redis.zscore(ckVtimeKey, gatedVariant)).not.toBeNull();

        // Registering must not resurrect a ckVtime entry with no ckIndex member, and the key
        // it may have just created has to carry the state TTL rather than leaking.
        expect(await on.redis.zscore(ckIndexKey, gatedVariant)).not.toBeNull();
        expect(await on.redis.ttl(ckVtimeKey)).toBeGreaterThan(0);

        // Once the ceiling clears it serves, and from the fair pass rather than by age.
        await on.redis.srem(
          testOptions.keys.queueCurrentConcurrencyKeyFromQueue(gatedVariant),
          "occupant"
        );
        const after = await on.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 1);
        expect(after.map((m) => m.messageId)).toEqual(["r-gated-0"]);
      } finally {
        await off.quit();
        await on.quit();
      }
    }
  );

  redisTest(
    "a ckVtime entry stranded by an ack is collected by the next scan",
    async ({ redisContainer }) => {
      // ckVtime is maintained by the enqueue, nack and dequeue scripts. Ack is not one of
      // them: acknowledgeMessageCkTracked ZREMs the variant from ckIndex when the zset
      // empties, has no vtime counterpart, and its caller does not branch on the flag, so
      // acking a message that is still QUEUED (a cancellation) leaves a ckVtime entry with
      // no ckIndex member. The TTL-expiry and dead-letter scripts strand one the same way.
      // The membership test above records that this direction of the invariant is allowed
      // to break; what it does not cover is the other half of the bargain, that a scan
      // collects the orphan. It does, and promptly: a stranded tag stops advancing while
      // live variants climb, so it sorts to the front of the window and is visited at no
      // cost to the batch.
      const queue = createQueue(redisContainer);
      try {
        const t0 = Date.now() - 100_000;

        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: makeMessage({ runId: "r-ghost", concurrencyKey: "ghost", timestamp: t0 }),
          workerQueue: authenticatedEnvDev.id,
          skipDequeueProcessing: true,
        });
        for (let i = 0; i < 10; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: makeMessage({
              runId: `r-live-${i}`,
              concurrencyKey: "live",
              timestamp: t0 + 100 + i,
            }),
            workerQueue: authenticatedEnvDev.id,
            skipDequeueProcessing: true,
          });
        }

        const ghostVariant = variantName("ghost");
        const ckIndexKey = testOptions.keys.ckIndexKeyFromQueue(ghostVariant);
        const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(ghostVariant);

        expect(await queue.redis.zscore(ckIndexKey, ghostVariant)).not.toBeNull();
        expect(await queue.redis.zscore(ckVtimeKey, ghostVariant)).not.toBeNull();

        // Never dequeued, so this is the cancellation path rather than a normal completion.
        await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, "r-ghost", {
          skipDequeueProcessing: true,
        });

        expect(await queue.redis.zscore(ckIndexKey, ghostVariant)).toBeNull();
        expect(await queue.redis.zscore(ckVtimeKey, ghostVariant)).not.toBeNull();

        const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
        const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 1);

        // ghost holds the lowest tag, so the very next scan visits and collects it, and the
        // wasted candidate slot costs the batch nothing: the call still served real work.
        expect(await queue.redis.zscore(ckVtimeKey, ghostVariant)).toBeNull();
        expect(messages.length).toBe(1);
        expect(messages[0]!.message.concurrencyKey).toBe("live");
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "flag off creates no vtime keys and matches head-timestamp order",
    async ({ redisContainer }) => {
      // ckVirtualTimeScheduling ABSENT: the off path calls the pre-existing
      // command names (enqueueMessage*CkTracked, dequeueMessagesFromCkQueueTracked,
      // nackMessageCkTracked) whose defineCommand script text this feature never
      // edited, so the stronger same-script-SHA guarantee holds by construction.
      // What a test CAN observe is asserted here: no vtime state is ever created,
      // and the dequeue order is head-timestamp (age) order, matching the
      // pre-existing ckIndex.test.ts expectation.
      const queue = createQueue(redisContainer, null);
      try {
        const t0 = Date.now() - 100_000;

        // 3 variants with distinct head ages: old < mid < new, 3 messages each.
        const heads: Record<string, number> = {
          old: t0,
          mid: t0 + 10_000,
          new: t0 + 20_000,
        };
        for (const [ck, head] of Object.entries(heads)) {
          for (let i = 0; i < 3; i++) {
            await queue.enqueueMessage({
              env: authenticatedEnvDev,
              message: makeMessage({
                runId: `r-${ck}-${i}`,
                concurrencyKey: ck,
                timestamp: head + i,
              }),
              workerQueue: authenticatedEnvDev.id,
              skipDequeueProcessing: true,
            });
          }
        }

        const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);

        // The off-path command serves at most one message per variant per call,
        // visiting variants in ckIndex (head-timestamp) order: oldest head first.
        const first = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 5);
        expect(first.map((m) => m.message.concurrencyKey)).toEqual(["old", "mid", "new"]);

        // nack old's head (immediate retry), ack the rest
        const nackedId = first[0]!.messageId;
        await queue.nackMessage({
          orgId: authenticatedEnvDev.organization.id,
          messageId: nackedId,
          retryAt: Date.now(),
          skipDequeueProcessing: true,
        });
        for (const m of first.slice(1)) {
          await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, m.messageId, {
            skipDequeueProcessing: true,
          });
        }

        // Two more batched calls drain the original heads in age order each time.
        for (let call = 0; call < 2; call++) {
          const messages = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 5);
          expect(messages.map((m) => m.message.concurrencyKey)).toEqual(["old", "mid", "new"]);
          for (const m of messages) {
            await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, m.messageId, {
              skipDequeueProcessing: true,
            });
          }
        }

        // Only the nacked message remains; it is re-served.
        const last = await queue.testDequeueFromMasterQueue(shard, authenticatedEnvDev.id, 5);
        expect(last.length).toBe(1);
        expect(last[0]!.messageId).toBe(nackedId);
        expect(last[0]!.message.concurrencyKey).toBe("old");

        // After the whole mixed sequence (enqueues, batched dequeues, a nack,
        // acks, one message still in flight so the keyspace is non-empty) no
        // vtime state exists at all: no :ckVtime, no :ckVtimeFloor. The KEYS
        // scan is safe here because redisTest runs flushall before each test,
        // so the DB only holds this test's keys.
        const allKeys = await queue.redis.keys("*");
        expect(allKeys.length).toBeGreaterThan(0);
        expect(allKeys.filter((k) => k.includes("ckVtime"))).toEqual([]);

        await queue.acknowledgeMessage(authenticatedEnvDev.organization.id, nackedId, {
          skipDequeueProcessing: true,
        });
      } finally {
        await queue.quit();
      }
    }
  );

  // Cold start: the flag is turned on over a backlog that was queued while it was
  // off, so every variant is in ckIndex and none is in :ckVtime. Pass 1 can only
  // see registered variants, so the cohort pass 2 happens to register on the first
  // call is the only cohort pass 1 ever serves; while that cohort keeps the batch
  // full, pass 2 never runs again and the rest of the backlog is unreachable until
  // the cohort drains. A variant that gets no further enqueues and no nacks has no
  // other route into the fair order, so the bound below is the whole guarantee.
  //
  // The same shape covers a mixed deploy (an instance with the flag still off
  // enqueues through the non-vtime command) and a :ckVtime that expired while
  // ckIndex survived.
  describe("cold start over an unregistered backlog", () => {
    type ColdStartShape = {
      variants: number;
      perVariant: number;
      maxCount: number;
      scanWindowMultiplier?: number;
      // Calls the coldest variant (newest head, so last in the age order pass 2
      // walks) may wait before its first serve.
      bound: number;
    };

    // Enqueues the backlog with the flag OFF, then reopens the same keyspace with
    // it ON and drains, recording the call each variant was first served on.
    async function runColdStart(redisContainer: any, shape: ColdStartShape) {
      const t0 = Date.now() - 500_000;
      const cks = Array.from(
        { length: shape.variants },
        (_, k) => `ck${String(k).padStart(2, "0")}`
      );

      const before = createQueue(redisContainer, null);
      try {
        for (let i = 0; i < shape.perVariant; i++) {
          for (let k = 0; k < cks.length; k++) {
            await before.enqueueMessage({
              env: authenticatedEnvDev,
              message: makeMessage({
                runId: `${cks[k]}-${i}`,
                concurrencyKey: cks[k],
                // 1s of head-age spacing per variant, so ck00 is oldest and the
                // age order never reshuffles as heads advance by 1ms per serve.
                timestamp: t0 + k * 1_000 + i,
              }),
              workerQueue: authenticatedEnvDev.id,
              skipDequeueProcessing: true,
            });
          }
        }
      } finally {
        await before.quit();
      }

      const after = createQueue(redisContainer, {
        ...(shape.scanWindowMultiplier === undefined
          ? {}
          : { scanWindowMultiplier: shape.scanWindowMultiplier }),
      });
      try {
        const ckVtimeKey = testOptions.keys.ckVtimeKeyFromQueue(variantName(cks[0]!));
        const ckIndexKey = testOptions.keys.ckIndexKeyFromQueue(variantName(cks[0]!));
        // The premise: the whole backlog is in the age index and nothing is in the
        // fair order.
        expect(await after.redis.zcard(ckIndexKey)).toBe(shape.variants);
        expect(await after.redis.zcard(ckVtimeKey)).toBe(0);

        const shard = testOptions.keys.masterQueueShardForEnvironment(authenticatedEnvDev.id, 2);
        const total = shape.variants * shape.perVariant;
        const firstServeCall = new Map<string, number>();
        let served = 0;

        for (let call = 0; call < total + 10 && served < total; call++) {
          const messages = await after.testDequeueFromMasterQueue(
            shard,
            authenticatedEnvDev.id,
            shape.maxCount
          );
          for (const m of messages) {
            const ck = m.message.concurrencyKey!;
            if (!firstServeCall.has(ck)) firstServeCall.set(ck, call);
            served++;
            // Ack immediately so env concurrency never gates a serve: the only
            // thing under test is reachability.
            await after.acknowledgeMessage(authenticatedEnvDev.organization.id, m.messageId, {
              skipDequeueProcessing: true,
            });
          }
        }

        return { firstServeCall, served, total, coldest: cks[cks.length - 1]! };
      } finally {
        await after.quit();
      }
    }

    // Bounds are the measured value, not headroom: the harness has no wall-clock
    // wait and no randomness. The pre-fix figure in each comment is what the same
    // shape did when pass 2 was gated on dequeuedCount < actualMaxCount.
    const shapes: [string, ColdStartShape][] = [
      // Registered cohort (5) smaller than the backlog (8), both inside the
      // pass-1 window (15) and the pass-2 scan window (15). Pre-fix: call 12.
      ["8 variants, batch 5", { variants: 8, perVariant: 12, maxCount: 5, bound: 1 }],
      // Backlog exactly fills the pass-1 window (12), so discovery has to land in
      // more than one call. Pre-fix: call 16.
      ["12 variants, batch 4", { variants: 12, perVariant: 8, maxCount: 4, bound: 2 }],
      // scanWindowMultiplier 1 puts the pass-1 window (5) below the backlog, so
      // the window read can no longer tell which variants are already registered
      // and discovery falls back to the NX. Pre-fix: call 12.
      [
        "15 variants, batch 5, narrow fair window",
        { variants: 15, perVariant: 6, maxCount: 5, scanWindowMultiplier: 1, bound: 2 },
      ],
    ];

    for (const [name, shape] of shapes) {
      redisTest(
        `${name}: the coldest variant is served within ${shape.bound + 1} calls`,
        async ({ redisContainer }) => {
          const { firstServeCall, served, total, coldest } = await runColdStart(
            redisContainer,
            shape
          );

          // Work conservation: the backlog still drains completely.
          expect(served).toBe(total);
          expect(firstServeCall.size).toBe(shape.variants);

          expect(
            firstServeCall.get(coldest),
            `coldest variant ${coldest} first served on call ${firstServeCall.get(coldest)}`
          ).toBeLessThanOrEqual(shape.bound);
        }
      );
    }
  });
});
