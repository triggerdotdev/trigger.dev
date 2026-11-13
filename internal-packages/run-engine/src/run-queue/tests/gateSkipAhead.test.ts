import { createRedisClient } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { Logger } from "@trigger.dev/core/logger";
import { Decimal } from "@trigger.dev/database";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect } from "vitest";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";

const keys = new RunQueueFullKeyProducer();

const env = {
  id: "e1234",
  type: "DEVELOPMENT" as const,
  maximumConcurrencyLimit: 100_000,
  concurrencyLimitBurstFactor: new Decimal(2.0),
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

const QUEUE = "task/my-task";
const OTHER_QUEUE = "task/other-task";
const GATE = "tenant-gate";
const GATE_B = "second-gate";
const KEY_PREFIX = "runqueue:test:";
const A = [{ queue: GATE, concurrencyKey: "A" }];

type Gates = Array<{ queue: string; concurrencyKey?: string }>;
type Setup = {
  skipAhead: boolean;
  gates?: boolean;
  keyLimits?: boolean;
  reconcileLockTtlSeconds?: number;
  reconcileMaxPasses?: number;
  meter?: any;
  readMultiplier?: number;
};

function createQueue(redisContainer: any, setup: Setup) {
  const redis = {
    keyPrefix: KEY_PREFIX,
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
  };
  return new RunQueue({
    name: "rq",
    tracer: trace.getTracer("rq"),
    workers: 1,
    defaultEnvConcurrency: 100_000,
    logger: new Logger("RunQueue", "error"),
    retryOptions: {
      maxAttempts: 5,
      factor: 1.1,
      minTimeoutInMs: 100,
      maxTimeoutInMs: 1000,
      randomize: true,
    },
    keys,
    masterQueueConsumersDisabled: true,
    reconcile: {
      lockTtlSeconds: setup.reconcileLockTtlSeconds,
      maxPassesPerDequeue: setup.reconcileMaxPasses,
    },
    workerOptions: { disabled: true },
    totalConcurrencyEnabled: true,
    gatesEnabled: setup.gates ?? true,
    concurrencyKeyLimitsEnabled: setup.keyLimits,
    gateSkipAhead: { enabled: setup.skipAhead, readMultiplier: setup.readMultiplier },
    meter: setup.meter,
    queueSelectionStrategy: new FairQueueSelectionStrategy({ redis, keys }),
    redis,
  } as any) as any;
}

/** One run on the sub-queue `session` of `queueName`, holding `gates`. */
async function enqueue(
  queue: any,
  runId: string,
  session: string,
  timestamp: number,
  gates?: Gates,
  extra: Partial<InputPayload> = {},
  queueName = QUEUE
) {
  const message: InputPayload = {
    runId,
    taskIdentifier: queueName,
    orgId: env.organization.id,
    projectId: env.project.id,
    environmentId: env.id,
    environmentType: "DEVELOPMENT",
    queue: queueName,
    concurrencyKey: session,
    timestamp,
    attempt: 0,
    gates,
    ...extra,
  };
  await queue.enqueueMessage({ env, message, workerQueue: env.id, skipDequeueProcessing: true });
}

const shard = () => keys.masterQueueShardForEnvironment(env.id, 2);
const ack = (queue: any, runId: string) =>
  queue.acknowledgeMessage(env.organization.id, runId, { skipDequeueProcessing: true });
const base = (queueName = QUEUE) => `${KEY_PREFIX}${keys.queueKey(env, queueName)}`;
const pool = (key: string, gate = GATE) => `${base(gate)}:ck:${key}:currentConcurrency`;

async function raw<T>(redisContainer: any, fn: (redis: any) => Promise<T>): Promise<T> {
  const redis = createRedisClient({
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
  });
  try {
    return await fn(redis);
  } finally {
    await redis.quit();
  }
}

/** A dequeue of the queue right now; sub-queues keep whatever retry time they have. */
async function dequeue(queue: any, redisContainer: any, queueName = QUEUE): Promise<string[]> {
  await raw(redisContainer, (redis) =>
    redis.zadd(
      `${KEY_PREFIX}${keys.masterQueueKeyForShard(shard())}`,
      0,
      keys.toCkWildcard(keys.queueKey(env, queueName, "any"))
    )
  );
  return (await queue.testDequeueFromMasterQueue(shard(), env.id, 10)).map((m: any) => m.messageId);
}

/**
 * A dequeue with every backed-off sub-queue due again and, as after a real 1s retry, older
 * in the index than anything enqueued since.
 */
async function dequeueDue(queue: any, redisContainer: any, queueName = QUEUE): Promise<string[]> {
  await raw(redisContainer, async (redis) => {
    const ckIndex = `${KEY_PREFIX}${keys.ckIndexKeyFromQueue(keys.queueKey(env, queueName))}`;
    const now = Date.now();
    for (const name of await redis.zrangebyscore(ckIndex, now, "+inf")) {
      await redis.zadd(ckIndex, now - 60_000, name);
    }
  });
  return dequeue(queue, redisContainer, queueName);
}

/** Hint keys: strings, unlike a sub-queue whose concurrency key happens to contain "ckHint". */
const hintKeys = (redisContainer: any): Promise<string[]> =>
  raw(redisContainer, async (redis) => {
    const found: string[] = [];
    for (const key of await redis.keys("*ckHint*")) {
      if ((await redis.type(key)) === "string") found.push(key);
    }
    return found;
  });
const hintKeyFor = (session: string) => `${base()}:ckHint:${session}`;
/** The kind of pool each hint names: "k" for a per-key pool, "t" for a total pool. */
const hintKinds = (redisContainer: any): Promise<string[]> =>
  raw(redisContainer, async (redis) => {
    const kinds: string[] = [];
    for (const key of await hintKeys(redisContainer))
      kinds.push(JSON.parse(await redis.get(key))[1]);
    return kinds;
  });
/** SET calls since the last RESETSTAT: hint writes, plus a reconcile's lock and cursor. */
const setCalls = (redisContainer: any): Promise<number> =>
  raw(redisContainer, async (redis) => {
    const match = /cmdstat_set:calls=(\d+)/.exec(await redis.info("commandstats"));
    return match ? Number(match[1]) : 0;
  });

const t0 = () => Date.now() - 100_000;

/** A meter to give a queue, and the read-exhausted count it has recorded so far. */
function exhaustedCounter() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
  const provider = new MeterProvider({ readers: [reader] });
  return {
    meter: provider.getMeter("run-queue-test"),
    count: async () => {
      await reader.forceFlush();
      const metric = exporter
        .getMetrics()
        .flatMap((r) => r.scopeMetrics)
        .flatMap((s) => s.metrics)
        .findLast((m) => m.descriptor.name === "runqueue.gate.skip_ahead_exhausted");
      return metric?.dataPoints.reduce((sum, point) => sum + Number(point.value), 0) ?? 0;
    },
  };
}

/** Enqueues `count` runs, each on its own sub-queue, a hundred at a time. */
async function enqueueMany(
  queue: any,
  count: number,
  name: (i: number) => [runId: string, session: string],
  timestamp: (i: number) => number,
  gates?: Gates
) {
  for (let from = 0; from < count; from += 100) {
    await Promise.all(
      Array.from({ length: Math.min(100, count - from) }, (_, j) =>
        enqueue(queue, ...name(from + j), timestamp(from + j), gates)
      )
    );
  }
}

/** A run on another queue takes the one slot of GATE's pool `key`. */
async function hold(queue: any, redisContainer: any, runId = "holder", gates: Gates = A) {
  await queue.updateQueueConcurrencyLimits(env, QUEUE, 50);
  await queue.updateQueueConcurrencyLimits(env, OTHER_QUEUE, 50);
  await enqueue(queue, runId, `hold-${runId}`, Date.now() - 500_000, gates, {}, OTHER_QUEUE);
  expect(await dequeueDue(queue, redisContainer, OTHER_QUEUE)).toEqual([runId]);
}

/**
 * Tenant A's one gate slot is held, then `blocked` of its sessions (a0, a1, ...) queue up,
 * all older than anything enqueued afterwards.
 */
async function blockTenantA(queue: any, redisContainer: any, blocked: number) {
  await queue.updateQueueConcurrencyLimits(env, GATE, 1);
  await hold(queue, redisContainer);
  for (let i = 0; i < blocked; i++) {
    await enqueue(queue, `a${i}`, `a-session-${i}`, t0() + 1 + i, A);
  }
}

describe("gate skip-ahead", () => {
  for (const skipAhead of [true, false]) {
    // Catches: gate-blocked sub-queues filling the dequeue window and starving other keys, or hints written when off.
    redisTest(
      `other keys are served past a blocked backlog wider than the window (skip-ahead: ${skipAhead})`,
      async ({ redisContainer }) => {
        const queue = createQueue(redisContainer, { skipAhead });
        try {
          await blockTenantA(queue, redisContainer, 100);
          for (let pass = 0; pass < 4; pass++) {
            expect(await dequeueDue(queue, redisContainer)).toEqual([]);
          }
          const now = Date.now() - 50;
          for (let i = 0; i < 5; i++) {
            await enqueue(queue, `b${i}`, `b-session-${i}`, now + i);
          }
          const served = await dequeueDue(queue, redisContainer);

          if (skipAhead) {
            expect(served.sort()).toEqual(["b0", "b1", "b2", "b3", "b4"]);
            expect((await hintKeys(redisContainer)).length).toBe(100);
          } else {
            expect(served).toEqual([]);
            expect(await hintKeys(redisContainer)).toEqual([]);
          }
        } finally {
          await queue.quit();
        }
      }
    );
  }

  // Catches: skip-ahead only working when a test rewinds retry times, not at the natural 1s retry.
  redisTest("other keys are served at the natural 1s retry cadence", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, { skipAhead: true });
    try {
      await blockTenantA(queue, redisContainer, 100);
      expect(await dequeue(queue, redisContainer)).toEqual([]);
      await sleep(1100);
      expect(await dequeue(queue, redisContainer)).toEqual([]);
      await sleep(1100);
      for (let i = 0; i < 5; i++) {
        await enqueue(queue, `b${i}`, `b-session-${i}`, Date.now());
      }
      expect((await dequeue(queue, redisContainer)).sort()).toEqual(["b0", "b1", "b2", "b3", "b4"]);
    } finally {
      await queue.quit();
    }
  });

  // Catches: a hint outliving its block, so freed capacity is not used on the next dequeue, or a hint with no expiry.
  redisTest(
    "freed capacity is used on the next dequeue, and no more than the limit",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, { skipAhead: true });
      try {
        await blockTenantA(queue, redisContainer, 5);
        expect(await dequeueDue(queue, redisContainer)).toEqual([]);
        expect(await dequeueDue(queue, redisContainer)).toEqual([]);
        const hints = await hintKeys(redisContainer);
        expect(hints.length).toBe(5);
        const expiry = await raw(redisContainer, (redis) => redis.ttl(hints[0]));
        expect(expiry).toBeGreaterThan(0);
        expect(expiry).toBeLessThanOrEqual(600);

        await ack(queue, "holder");
        expect(await dequeueDue(queue, redisContainer)).toEqual(["a0"]);
        expect(await dequeueDue(queue, redisContainer)).toEqual([]);

        await queue.updateQueueConcurrencyLimits(env, GATE, 3);
        expect((await dequeueDue(queue, redisContainer)).length).toBe(2);
        expect(await dequeueDue(queue, redisContainer)).toEqual([]);
        expect(await raw(redisContainer, (redis) => redis.scard(pool("A")))).toBe(3);

        for (const runId of ["a0", "a1", "a2"]) await ack(queue, runId);
        expect((await dequeueDue(queue, redisContainer)).sort()).toEqual(["a3", "a4"]);
        expect(await hintKeys(redisContainer)).toEqual([]);
      } finally {
        await queue.quit();
      }
    }
  );

  // Catches: a hint applied to a new head after the hinted head is removed or a run is enqueued ahead of it.
  redisTest("a new head is not held back by the old head's hint", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, { skipAhead: true });
    try {
      await blockTenantA(queue, redisContainer, 2);
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);

      await ack(queue, "a0");
      await enqueue(queue, "free0", "a-session-0", Date.now() - 50);
      await enqueue(queue, "free1", "a-session-1", Date.now() - 200_000);

      expect((await dequeueDue(queue, redisContainer)).sort()).toEqual(["free0", "free1"]);
    } finally {
      await queue.quit();
    }
  });

  // Catches: a run nacked to the front of a sub-queue being passed over on the hint of the head it displaced.
  redisTest("a run nacked ahead of a hinted head is served", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, { skipAhead: true });
    try {
      await queue.updateQueueConcurrencyLimits(env, QUEUE, 50);
      await queue.updateQueueConcurrencyLimits(env, GATE, 1);
      const t = t0();
      await enqueue(queue, "holder", "sx", t, A);
      expect(await dequeueDue(queue, redisContainer)).toEqual(["holder"]);
      await enqueue(queue, "z", "sx", t + 1);
      expect(await dequeueDue(queue, redisContainer)).toEqual(["z"]);
      await enqueue(queue, "x", "sx", t + 10, A);
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);
      expect((await hintKeys(redisContainer)).length).toBe(1);

      await queue.nackMessage({
        orgId: env.organization.id,
        messageId: "z",
        retryAt: t + 2,
        skipDequeueProcessing: true,
      });
      expect(await dequeueDue(queue, redisContainer)).toEqual(["z"]);
    } finally {
      await queue.quit();
    }
  });

  // Catches: a junk hint, a hint for another head, or one naming a pool with room skipping the normal admission check.
  redisTest(
    "a malformed or stale hint cannot hold back a servable run",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, { skipAhead: true });
      try {
        await queue.updateQueueConcurrencyLimits(env, QUEUE, 50);
        await queue.updateQueueConcurrencyLimits(env, GATE, 5);
        const now = Date.now() - 1000;
        await enqueue(queue, "s0", "junk", now, A);
        await enqueue(queue, "s1", "other-head", now + 1, A);
        await enqueue(queue, "s2", "room", now + 2, A);
        await enqueue(queue, "s3", "wrong-shape", now + 3, A);
        await raw(redisContainer, async (redis) => {
          await redis.set(hintKeyFor("junk"), "not json");
          await redis.set(
            hintKeyFor("other-head"),
            JSON.stringify(["gone", "k", base(GATE), "A", 0])
          );
          await redis.set(hintKeyFor("room"), JSON.stringify(["s2", "k", base(GATE), "A", 0]));
          await redis.set(hintKeyFor("wrong-shape"), JSON.stringify({ head: "s3" }));
        });

        expect((await dequeueDue(queue, redisContainer)).sort()).toEqual(["s0", "s1", "s2", "s3"]);
        expect(await hintKeys(redisContainer)).toEqual([]);
      } finally {
        await queue.quit();
      }
    }
  );

  // Catches: a run already counted in its hinted pool being passed over, or pruned from it by the hint's reconcile.
  redisTest("a run already in the hinted pool is admitted", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, {
      skipAhead: true,
      reconcileLockTtlSeconds: 1,
    });
    try {
      await blockTenantA(queue, redisContainer, 1);
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);
      await raw(redisContainer, (redis) => redis.sadd(pool("A"), "a0"));
      await sleep(1100);
      expect(await dequeueDue(queue, redisContainer)).toEqual(["a0"]);
    } finally {
      await queue.quit();
    }
  });

  // Catches: a run already in its pool passed over because an earlier sub-queue in the call marked the pool full.
  redisTest(
    "a run already in a pool found full earlier in the call is admitted",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, { skipAhead: true });
      try {
        await queue.updateQueueConcurrencyLimits(env, GATE, 1);
        await hold(queue, redisContainer);
        await enqueue(queue, "member", "s-member", t0() + 50, A);
        expect(await dequeueDue(queue, redisContainer)).toEqual([]);
        expect((await hintKeys(redisContainer)).length).toBe(1);
        await raw(redisContainer, (redis) => redis.sadd(pool("A"), "member"));
        await enqueue(queue, "first", "s-first", t0() - 200_000, A);
        expect(await dequeueDue(queue, redisContainer)).toEqual(["member"]);
      } finally {
        await queue.quit();
      }
    }
  );

  // Catches: every waiter on a pool re-reading its payload and rewriting its hint when only one slot was free.
  redisTest(
    "one free slot costs one payload read, not one per waiter",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, { skipAhead: true });
      try {
        const waiters = 40;
        await blockTenantA(queue, redisContainer, waiters);
        expect(await dequeueDue(queue, redisContainer)).toEqual([]);
        expect(await dequeueDue(queue, redisContainer)).toEqual([]);
        await queue.updateQueueConcurrencyLimits(env, GATE, 2);

        await raw(redisContainer, (redis) => redis.config("RESETSTAT"));
        expect(await dequeueDue(queue, redisContainer)).toEqual(["a0"]);
        expect(await setCalls(redisContainer)).toBeLessThan(waiters / 2);
      } finally {
        await queue.quit();
      }
    }
  );

  for (const skipAhead of [true, false]) {
    // Catches: running out of read on gate-blocked sub-queues going unreported, or reported within reach or when off.
    redisTest(
      `a dequeue that runs out of read on blocked sub-queues is counted (skip-ahead: ${skipAhead})`,
      async ({ redisContainer }) => {
        const exhausted = exhaustedCounter();
        const queue = createQueue(redisContainer, { skipAhead, meter: exhausted.meter });
        try {
          await queue.updateQueueConcurrencyLimits(env, GATE, 1);
          await hold(queue, redisContainer);
          await enqueueMany(
            queue,
            300,
            (i) => [`a${i}`, `a-session-${i}`],
            (i) => t0() + 1 + i,
            A
          );
          expect(await dequeueDue(queue, redisContainer)).toEqual([]);
          expect(await exhausted.count()).toBe(0);

          await enqueue(queue, "behind", "free-session", Date.now() - 1000);
          expect(await dequeueDue(queue, redisContainer)).toEqual([]);
          if (skipAhead) {
            expect(await exhausted.count()).toBeGreaterThanOrEqual(1);
          } else {
            expect(await exhausted.count()).toBe(0);
          }
        } finally {
          await queue.quit();
        }
      }
    );
  }

  // Catches: a dequeue that stopped for a full batch or for blocks other than a gate being reported as out of read.
  redisTest(
    "a dequeue that stops for its batch or its window is not counted",
    async ({ redisContainer }) => {
      const exhausted = exhaustedCounter();
      const queue = createQueue(redisContainer, { skipAhead: true, meter: exhausted.meter });
      try {
        await blockTenantA(queue, redisContainer, 5);
        await enqueueMany(
          queue,
          400,
          (i) => [`free${i}`, `free-session-${i}`],
          (i) => Date.now() - 1000 + i
        );
        expect((await dequeueDue(queue, redisContainer)).length).toBe(10);
        expect(await exhausted.count()).toBe(0);

        await queue.updateQueueTotalConcurrencyLimits(env, QUEUE, 10);
        expect(await dequeueDue(queue, redisContainer)).toEqual([]);
        expect(await exhausted.count()).toBe(0);
      } finally {
        await queue.quit();
      }
    }
  );

  // Catches: skip-ahead reading past the candidate window for sub-queues held back by something other than a gate.
  redisTest(
    "a saturated queue with no gates reads no further than before",
    async ({ redisContainer }) => {
      const commands: number[] = [];
      for (const skipAhead of [false, true]) {
        await raw(redisContainer, (redis) => redis.flushall());
        const queue = createQueue(redisContainer, { skipAhead });
        try {
          await queue.updateQueueConcurrencyLimits(env, QUEUE, 50);
          await enqueueMany(
            queue,
            200,
            (i) => [`r${i}`, `s${String(i).padStart(4, "0")}`],
            (i) => t0() + i
          );
          expect((await dequeueDue(queue, redisContainer)).length).toBe(10);
          await queue.updateQueueTotalConcurrencyLimits(env, QUEUE, 10);
          expect(await dequeueDue(queue, redisContainer)).toEqual([]);
          await raw(redisContainer, (redis) => redis.config("RESETSTAT"));
          expect(await dequeueDue(queue, redisContainer)).toEqual([]);
          commands.push(
            await raw(redisContainer, async (redis) => {
              let calls = 0;
              for (const line of (await redis.info("commandstats")).split("\n")) {
                const match = /^cmdstat_([^:]+):calls=(\d+)/.exec(line);
                if (match && !["info", "config", "evalsha"].includes(match[1]))
                  calls += Number(match[2]);
              }
              return calls;
            })
          );
        } finally {
          await queue.quit();
        }
      }
      const [off, on] = commands;
      expect(on).toBeLessThanOrEqual(off + 40);
    }
  );

  // Catches: a read multiplier above the bound being honoured.
  redisTest("the read multiplier is bounded at 20", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, { skipAhead: true, readMultiplier: 100 });
    try {
      await queue.updateQueueConcurrencyLimits(env, GATE, 1);
      await hold(queue, redisContainer);
      await enqueueMany(
        queue,
        650,
        (i) => [`a${i}`, `a-session-${i}`],
        (i) => t0() + 1 + i,
        A
      );
      for (let i = 0; i < 5; i++) {
        await enqueue(queue, `b${i}`, `b-session-${i}`, Date.now() - 50 + i);
      }
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);
    } finally {
      await queue.quit();
    }
  });

  // Catches: a total-limit hint checking the wrong set or limit, so a counted run or a raised total is not admitted.
  redisTest("a hint for a full total pool follows the total limit", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, { skipAhead: true });
    try {
      await queue.updateQueueConcurrencyLimits(env, QUEUE, 50);
      await queue.updateQueueConcurrencyLimits(env, GATE, 1);
      await queue.updateQueueTotalConcurrencyLimits(env, GATE, 3);
      for (let i = 0; i < 12; i++) {
        await enqueue(queue, `y${i}`, `s${i}`, t0() + i, [{ queue: GATE }]);
      }
      expect((await dequeueDue(queue, redisContainer)).length).toBe(3);
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);
      expect(new Set(await hintKinds(redisContainer))).toEqual(new Set(["t"]));
      await raw(redisContainer, (redis) => redis.config("RESETSTAT"));
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);
      expect(await setCalls(redisContainer)).toBeLessThanOrEqual(2);

      await raw(redisContainer, (redis) => redis.sadd(`${base(GATE)}:groupConcurrency`, "y3"));
      expect(await dequeueDue(queue, redisContainer)).toEqual(["y3"]);

      await queue.updateQueueTotalConcurrencyLimits(env, GATE, 5);
      expect((await dequeueDue(queue, redisContainer)).length).toBe(1);
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);
      expect(
        await raw(redisContainer, (redis) => redis.scard(`${base(GATE)}:groupConcurrency`))
      ).toBe(5);
    } finally {
      await queue.quit();
    }
  });

  // Catches: a hint judging the pool by the gate's declared per-key limit when a per-key override applies.
  redisTest("a hint honours a per-key override on the pool", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, { skipAhead: true, keyLimits: true });
    try {
      await blockTenantA(queue, redisContainer, 3);
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);
      await queue.updateQueueConcurrencyKeyLimit(env, GATE, "A", 2, 60);
      expect(await dequeueDue(queue, redisContainer)).toEqual(["a0"]);
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);
    } finally {
      await queue.quit();
    }
  });

  // Catches: a two-gate run held by a hint for a gate that freed, or let through while its other gate is full.
  redisTest("a run with two gates follows whichever one is full", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, { skipAhead: true });
    try {
      await queue.updateQueueConcurrencyLimits(env, GATE, 1);
      await queue.updateQueueConcurrencyLimits(env, GATE_B, 1);
      const gateB = [{ queue: GATE_B, concurrencyKey: "B" }];
      await hold(queue, redisContainer, "hold-b", gateB);
      await enqueue(queue, "x", "sx", t0(), [...A, ...gateB]);
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);

      await hold(queue, redisContainer, "hold-a", A);
      await ack(queue, "hold-b");
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);

      await ack(queue, "hold-a");
      expect(await dequeueDue(queue, redisContainer)).toEqual(["x"]);
    } finally {
      await queue.quit();
    }
  });

  // Catches: hints written while gates were enforced still holding runs back once gates are switched off.
  redisTest("switching gates off releases hinted runs", async ({ redisContainer }) => {
    const enforcing = createQueue(redisContainer, { skipAhead: true });
    await blockTenantA(enforcing, redisContainer, 3);
    expect(await dequeueDue(enforcing, redisContainer)).toEqual([]);
    expect(await dequeueDue(enforcing, redisContainer)).toEqual([]);
    expect((await hintKeys(redisContainer)).length).toBe(3);
    await enforcing.quit();

    const queue = createQueue(redisContainer, { skipAhead: true, gates: false });
    try {
      expect((await dequeueDue(queue, redisContainer)).sort()).toEqual(["a0", "a1", "a2"]);
    } finally {
      await queue.quit();
    }
  });

  for (const mode of ["expired", "orphaned"] as const) {
    // Catches: an expired or orphaned hinted head being passed over, leaving the runs behind it stuck.
    redisTest(
      `an ${mode} hinted head does not hold up the run behind it`,
      async ({ redisContainer }) => {
        const queue = createQueue(redisContainer, { skipAhead: true });
        try {
          await queue.updateQueueConcurrencyLimits(env, GATE, 1);
          await hold(queue, redisContainer);
          const extra = mode === "expired" ? { ttlExpiresAt: Date.now() + 1200 } : {};
          await enqueue(queue, "x", "sx", t0(), A, extra);
          await enqueue(queue, "y", "sx", t0() + 5);
          expect(await dequeueDue(queue, redisContainer)).toEqual([]);
          expect(await dequeueDue(queue, redisContainer)).toEqual([]);
          expect((await hintKeys(redisContainer)).length).toBe(1);

          if (mode === "expired") {
            await sleep(1500);
          } else {
            await raw(redisContainer, (redis) =>
              redis.del(`${KEY_PREFIX}${keys.messageKey(env.organization.id, "x")}`)
            );
          }
          const served: string[] = [];
          for (let pass = 0; pass < 2; pass++)
            served.push(...(await dequeueDue(queue, redisContainer)));
          expect(served).toEqual(["y"]);
        } finally {
          await queue.quit();
        }
      }
    );
  }

  // Catches: a leaked slot never pruned once all its waiters are skipped by hint, or the pruned pool still read as full.
  redisTest(
    "a leaked slot in a hinted pool is pruned and used in the same dequeue",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, {
        skipAhead: true,
        reconcileLockTtlSeconds: 1,
      });
      try {
        await blockTenantA(queue, redisContainer, 2);
        expect(await dequeueDue(queue, redisContainer)).toEqual([]);
        await raw(redisContainer, (redis) =>
          redis.del(`${KEY_PREFIX}${keys.messageKey(env.organization.id, "holder")}`)
        );
        await sleep(1100);
        expect(await dequeueDue(queue, redisContainer)).toEqual(["a0"]);
      } finally {
        await queue.quit();
      }
    }
  );

  // Catches: skip-ahead raising a reconcile pass budget that was set to zero to switch passes off.
  redisTest("a reconcile pass budget of zero stays zero", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, {
      skipAhead: true,
      reconcileLockTtlSeconds: 1,
      reconcileMaxPasses: 0,
    });
    try {
      await blockTenantA(queue, redisContainer, 1);
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);
      await raw(redisContainer, (redis) =>
        redis.del(`${KEY_PREFIX}${keys.messageKey(env.organization.id, "holder")}`)
      );
      await sleep(1100);
      expect(await dequeueDue(queue, redisContainer)).toEqual([]);
    } finally {
      await queue.quit();
    }
  });

  // Catches: the check whose reconcile pruned a leaked slot marking the pool full for the rest of the call.
  redisTest(
    "a pool pruned while blocking one run is open to the next in the same dequeue",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, {
        skipAhead: true,
        reconcileLockTtlSeconds: 1,
      });
      try {
        await queue.updateQueueConcurrencyLimits(env, GATE, 1);
        await hold(queue, redisContainer);
        await enqueue(queue, "later", "s-later", t0() + 50, A);
        expect(await dequeueDue(queue, redisContainer)).toEqual([]);
        expect((await hintKeys(redisContainer)).length).toBe(1);
        await raw(redisContainer, (redis) =>
          redis.del(`${KEY_PREFIX}${keys.messageKey(env.organization.id, "holder")}`)
        );
        await sleep(1100);
        await enqueue(queue, "first", "s-first", t0() - 200_000, A);
        expect(await dequeueDue(queue, redisContainer)).toEqual(["later"]);
      } finally {
        await queue.quit();
      }
    }
  );

  // Catches: a hint key built from an odd concurrency key hitting another key, breaking the script or leaking.
  redisTest(
    "concurrency keys with delimiters and odd characters are handled",
    async ({ redisContainer }) => {
      const sessions = [
        "a:ck:b",
        "x:currentConcurrency",
        "{evil}",
        "}{org:other}",
        'q"uo\\te',
        "ünï©ødé✓",
        "k".repeat(128),
        "a:ckHint:b",
        " ",
        "*",
        "ckHint:",
        ":ck:",
        "]",
        "[1,2]",
      ];
      const queue = createQueue(redisContainer, { skipAhead: true });
      try {
        await queue.updateQueueConcurrencyLimits(env, GATE, 1);
        await hold(queue, redisContainer);
        for (const [i, session] of sessions.entries()) {
          await enqueue(queue, `w${i}`, session, t0() + i, A);
        }
        for (let pass = 0; pass < 3; pass++) {
          expect(await dequeueDue(queue, redisContainer)).toEqual([]);
        }
        const hints = await hintKeys(redisContainer);
        expect(hints.length).toBe(sessions.length);
        expect(hints.filter((key) => !key.startsWith(`${base()}:ckHint:`))).toEqual([]);

        await queue.updateQueueConcurrencyLimits(env, GATE, 100);
        const served: string[] = [];
        for (let pass = 0; pass < 3; pass++)
          served.push(...(await dequeueDue(queue, redisContainer)));
        expect(served.length).toBe(sessions.length);
        expect(await hintKeys(redisContainer)).toEqual([]);
      } finally {
        await queue.quit();
      }
    }
  );
});

describe("gate skip-ahead, self-heal", () => {
  for (const pools of [150, 300, 1000]) {
    // Catches: a dequeue backing off far more leaked pools than its reconcile budget can heal.
    redisTest(
      `${pools} leaked per-key pools heal no slower than without skip-ahead`,
      async ({ redisContainer }) => {
        const served: number[] = [];
        for (const skipAhead of [false, true]) {
          await raw(redisContainer, (redis) => redis.flushall());
          const queue = createQueue(redisContainer, { skipAhead });
          try {
            await queue.updateQueueConcurrencyLimits(env, QUEUE, 50);
            await queue.updateQueueConcurrencyLimits(env, GATE, 1);
            await raw(redisContainer, async (redis) => {
              const pipeline = redis.pipeline();
              for (let i = 0; i < pools; i++) pipeline.sadd(pool(`s${i}`), `ghost${i}`);
              await pipeline.exec();
            });
            await enqueueMany(
              queue,
              pools,
              (i) => [`r${i}`, `s${i}`],
              (i) => t0() + i,
              [{ queue: GATE }]
            );
            const startedAt = Date.now();
            let count = 0;
            while (Date.now() - startedAt < 5000) {
              count += (await dequeue(queue, redisContainer)).length;
              await sleep(100);
            }
            served.push(count);
          } finally {
            await queue.quit();
          }
        }
        const [off, on] = served;
        expect(on).toBeGreaterThanOrEqual(off);
      }
    );
  }

  for (const skipAhead of [true, false]) {
    // Catches: reconcile work bounded only by passes with skip-ahead on, or more than the configured passes with it off.
    redisTest(
      `reconcile scanning is bounded by members, not only by passes (skip-ahead: ${skipAhead})`,
      async ({ redisContainer }) => {
        const queue = createQueue(redisContainer, { skipAhead });
        try {
          const pools = 20;
          const members = 60;
          await queue.updateQueueConcurrencyLimits(env, QUEUE, 50);
          await queue.updateQueueConcurrencyLimits(env, GATE, members);
          await raw(redisContainer, async (redis) => {
            const pipeline = redis.pipeline();
            const home = keys.queueKey(env, OTHER_QUEUE);
            for (let p = 0; p < pools; p++) {
              for (let m = 0; m < members; m++) {
                const runId = `held-${p}-${m}`;
                pipeline.set(
                  `${KEY_PREFIX}${keys.messageKey(env.organization.id, runId)}`,
                  JSON.stringify({ queue: home })
                );
                pipeline.sadd(`${KEY_PREFIX}${home}:currentConcurrency`, runId);
                pipeline.sadd(pool(`P${p}`), runId);
              }
            }
            await pipeline.exec();
          });
          for (let p = 0; p < pools; p++) {
            await enqueue(queue, `w${p}`, `w-session-${p}`, t0() + p, [
              { queue: GATE, concurrencyKey: `P${p}` },
            ]);
          }
          await raw(redisContainer, (redis) => redis.config("RESETSTAT"));
          expect(await dequeueDue(queue, redisContainer)).toEqual([]);
          const scans = await raw(redisContainer, async (redis) => {
            const match = /cmdstat_sscan:calls=(\d+)/.exec(await redis.info("commandstats"));
            return match ? Number(match[1]) : 0;
          });
          expect(scans).toBe(skipAhead ? 10 : 2);
          expect(await raw(redisContainer, (redis) => redis.scard(pool("P0")))).toBe(members);
        } finally {
          await queue.quit();
        }
      }
    );
  }

  // Catches: the member budget denying a pool its pass when scan pages return more members than the scan count.
  redisTest(
    "six saturated pools larger than the scan count are all healed by one dequeue",
    async ({ redisContainer }) => {
      const queue = createQueue(redisContainer, { skipAhead: true });
      try {
        const pools = 6;
        const members = 128;
        await queue.updateQueueConcurrencyLimits(env, QUEUE, 50);
        await queue.updateQueueConcurrencyLimits(env, GATE, members);
        await raw(redisContainer, async (redis) => {
          const pipeline = redis.pipeline();
          const home = keys.queueKey(env, OTHER_QUEUE);
          for (let p = 0; p < pools; p++) {
            pipeline.sadd(pool(`P${p}`), `ghost-${p}`);
            for (let m = 1; m < members; m++) {
              const runId = `held-${p}-${m}`;
              pipeline.set(
                `${KEY_PREFIX}${keys.messageKey(env.organization.id, runId)}`,
                JSON.stringify({ queue: home })
              );
              pipeline.sadd(`${KEY_PREFIX}${home}:currentConcurrency`, runId);
              pipeline.sadd(pool(`P${p}`), runId);
            }
          }
          await pipeline.exec();
        });
        for (let p = 0; p < pools; p++) {
          await enqueue(queue, `w${p}`, `w-session-${p}`, t0() + p, [
            { queue: GATE, concurrencyKey: `P${p}` },
          ]);
        }
        expect(await dequeueDue(queue, redisContainer)).toEqual([]);
        const sizes = await raw(redisContainer, (redis) =>
          Promise.all(Array.from({ length: pools }, (_, p) => redis.scard(pool(`P${p}`))))
        );
        expect(sizes).toEqual(Array.from({ length: pools }, () => members - 1));
        expect((await dequeueDue(queue, redisContainer)).length).toBe(pools);
      } finally {
        await queue.quit();
      }
    }
  );
});
