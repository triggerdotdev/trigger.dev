import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { Decimal } from "@trigger.dev/database";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import type { InputPayload } from "../types.js";

// Starvation of a persistently-backlogged CK variant by variants that drain on every call.
//
// A variant that empties is GC'd out of ckVtime, and before the idle zset its next enqueue
// re-registered it at the floor: full credit, every call. A variant carrying a backlog
// keeps advancing its tag and never gets it back, so it loses every comparison. Measured
// on the plain shape below: 1 serve out of 600 with the flag on, against 120 with it off.
//
// ckVtimeIdle remembers the tag across a drain, so re-registration takes
// max(floor, idleTag) and a drain buys nothing. Each shape here asserts the backlogged
// variant lands near its round-robin share of 1/(1 + competitors).
//
// Shapes covered: the plain trickle shape, more trickles than batch slots, a
// concurrency-gated variant pinned at a low tag, a future-headed variant pinned at a low
// tag, and a deep-queue control whose competitors never drain (so they were never affected
// by the bug, and it shows what the fair share is).

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

const baseEnv = {
  id: "e1234",
  type: "DEVELOPMENT" as const,
  maximumConcurrencyLimit: 20,
  concurrencyLimitBurstFactor: new Decimal(1),
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

const QUEUE = "task/my-task";

function createQueue(
  redisContainer: any,
  keyPrefix: string,
  vtimeEnabled: boolean,
  idleMaxEntries?: number
) {
  return new RunQueue({
    ...testOptions,
    masterQueueConsumersDisabled: true,
    workerOptions: { disabled: true },
    ...(vtimeEnabled
      ? {
          ckVirtualTimeScheduling: { enabled: true, ...(idleMaxEntries ? { idleMaxEntries } : {}) },
        }
      : {}),
    queueSelectionStrategy: new FairQueueSelectionStrategy({
      redis: { keyPrefix, host: redisContainer.getHost(), port: redisContainer.getPort() },
      keys: testOptions.keys,
    }),
    redis: { keyPrefix, host: redisContainer.getHost(), port: redisContainer.getPort() },
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
    queue: QUEUE,
    timestamp: Date.now(),
    attempt: 0,
    ...overrides,
  };
}

function variantName(ck: string): string {
  return testOptions.keys.queueKey(baseEnv, QUEUE, ck);
}

type RunOpts = {
  trickleCount: number;
  maxCount: number;
  calls: number;
  backlogSize: number;
  envLimit: number;
  // Control: give each competitor a deep backlog instead of one message, so it never
  // drains and is never GC'd out of ckVtime / re-registered.
  steadyCompetitors?: boolean;
  // A variant parked at the per-key concurrency ceiling for the whole run. It stays in
  // ckVtime holding a permanently low tag, which is what defeated the earlier floor-only
  // prototype of this fix.
  gatedVariant?: boolean;
  // A variant whose whole backlog is scheduled an hour out. Also stays registered at a
  // permanently low tag, by the 'notReady' route rather than the concurrency gate.
  futureVariant?: boolean;
};

type RunResult = {
  backlogServed: number;
  trickleServed: number;
  totalServed: number;
  lastBacklogServeCall: number;
  finalFloor: string | null;
  finalTags: Record<string, number>;
  idleSize: number;
};

async function runShape(
  redisContainer: any,
  label: string,
  vtimeEnabled: boolean,
  opts: RunOpts
): Promise<RunResult> {
  const keyPrefix = `runqueue:test:${label}:`;
  const queue = createQueue(redisContainer, keyPrefix, vtimeEnabled);

  try {
    const env = { ...baseEnv, maximumConcurrencyLimit: opts.envLimit };
    await queue.updateEnvConcurrencyLimits(env);

    const t0 = Date.now() - 10_000_000;

    const enqueue = async (runId: string, ck: string, timestamp: number) => {
      await queue.enqueueMessage({
        env,
        message: makeMessage({ runId, concurrencyKey: ck, timestamp }),
        workerQueue: env.id,
        skipDequeueProcessing: true,
      });
    };

    // Backlogged variant FIRST so its heads are the oldest in ckIndex.
    for (let i = 0; i < opts.backlogSize; i++) {
      await enqueue(`b${i}`, "backlog", t0 + i);
    }

    if (opts.gatedVariant) {
      // Ready, old work so it is a live ckIndex/ckVtime member every call...
      for (let i = 0; i < 50; i++) {
        await enqueue(`g${i}`, "gated", t0 + 100 + i);
      }
      // ...but parked at the per-key ceiling, so tryServe never serves it. The ceiling is
      // min(queue limit, env limit) and the queue limit is unset here, so it is envLimit.
      const members = Array.from({ length: opts.envLimit + 10 }, (_, i) => `held-${i}`);
      await queue.redis.sadd(`${variantName("gated")}:currentConcurrency`, ...members);
    }

    if (opts.futureVariant) {
      const future = Date.now() + 60 * 60 * 1000;
      for (let i = 0; i < 50; i++) {
        await enqueue(`f${i}`, "future", future + i);
      }
    }

    // One ready message per trickle variant, newer than the whole backlog, so age order
    // alone would never prefer them. Under steadyCompetitors each gets a deep queue.
    const seedPerCompetitor = opts.steadyCompetitors ? opts.calls + 10 : 1;
    for (let t = 0; t < opts.trickleCount; t++) {
      for (let i = 0; i < seedPerCompetitor; i++) {
        await enqueue(`t${t}-seed-${i}`, `trickle-${t}`, t0 + 5_000_000 + i);
      }
    }

    const shard = testOptions.keys.masterQueueShardForEnvironment(env.id, 2);

    let backlogServed = 0;
    let trickleServed = 0;
    let totalServed = 0;
    let lastBacklogServeCall = -1;
    let refeed = 0;

    for (let call = 0; call < opts.calls; call++) {
      const messages = await queue.testDequeueFromMasterQueue(shard, env.id, opts.maxCount);

      const drainedTrickles = new Set<string>();
      for (const m of messages) {
        const ck = m.message.concurrencyKey ?? "";
        totalServed++;
        if (ck === "backlog") {
          backlogServed++;
          lastBacklogServeCall = call;
        } else if (ck.startsWith("trickle-")) {
          trickleServed++;
          drainedTrickles.add(ck);
        }
        // Ack immediately: concurrency is never the limiting factor here.
        await queue.acknowledgeMessage(env.organization.id, m.messageId, {
          skipDequeueProcessing: true,
        });
      }

      if (opts.steadyCompetitors) continue;

      // Re-feed every trickle variant that drained, so it is ready again next call with a
      // strictly newer head than the backlog. This is the re-registration under test.
      for (const ck of drainedTrickles) {
        refeed++;
        await enqueue(`t-${ck}-${refeed}`, ck, t0 + 5_000_000 + refeed);
      }
    }

    const backlogVariant = variantName("backlog");
    const finalFloor = await queue.redis.get(
      testOptions.keys.ckVtimeFloorKeyFromQueue(backlogVariant)
    );
    const raw = await queue.redis.zrange(
      testOptions.keys.ckVtimeKeyFromQueue(backlogVariant),
      0,
      -1,
      "WITHSCORES"
    );
    const finalTags: Record<string, number> = {};
    for (let i = 0; i < raw.length; i += 2) {
      const member = raw[i]!;
      const short = member.includes(":ck:") ? member.slice(member.indexOf(":ck:") + 4) : member;
      finalTags[short] = Number(raw[i + 1]);
    }
    const idleSize = await queue.redis.zcard(
      testOptions.keys.ckVtimeIdleKeyFromQueue(backlogVariant)
    );

    return {
      backlogServed,
      trickleServed,
      totalServed,
      lastBacklogServeCall,
      finalFloor,
      finalTags,
      idleSize,
    };
  } finally {
    await queue.quit();
  }
}

// Round-robin share of the served batch for one variant among 1 + trickleCount claimants,
// which is what the deep-queue control measures out at.
function fairShare(opts: RunOpts, served: number): number {
  return served / (1 + opts.trickleCount);
}

// 0.7 rather than 1.0: pass 1 walks in tag order and pass 2 fills by age, so a variant can
// lose a slot to rounding at the batch boundary. The gap being defended against is two
// orders of magnitude (1 vs 100), so this has plenty of room and is not tuned to a number.
function expectFairish(label: string, opts: RunOpts, r: RunResult) {
  const target = fairShare(opts, r.totalServed);
  expect(
    r.backlogServed,
    `${label}: backlog served ${r.backlogServed} of ${r.totalServed}, fair share ${target.toFixed(
      1
    )}`
  ).toBeGreaterThanOrEqual(target * 0.7);
}

vi.setConfig({ testTimeout: 300_000 });

describe("CK vtime starvation by drain-and-re-register", () => {
  redisTest(
    "backlogged variant keeps its share against trickle variants (flag on vs off)",
    async ({ redisContainer }) => {
      const opts: RunOpts = {
        trickleCount: 5,
        maxCount: 5,
        calls: 120,
        backlogSize: 400,
        envLimit: 20,
      };

      const on = await runShape(redisContainer, "starve-on", true, opts);
      const off = await runShape(redisContainer, "starve-off", false, opts);

      expect(on.totalServed).toBe(600);
      expect(off.totalServed).toBe(600);

      // The comparison arm: flag off is pure age order, so the always-oldest backlog wins
      // a slot on every call. That is the number the flag-on path regressed against.
      expect(off.backlogServed).toBeGreaterThanOrEqual(100);

      expectFairish("flag on", opts, on);

      // It was served throughout, not just drained early and then starved.
      expect(on.lastBacklogServeCall).toBeGreaterThanOrEqual(opts.calls - 10);

      // The idle zset is reaped at or below the floor on every serving call, so it holds
      // at most the variants that drained since the last one.
      expect(on.idleSize).toBeLessThanOrEqual(opts.trickleCount + 2);
    }
  );

  redisTest(
    "holds when there are more trickle variants than batch slots",
    async ({ redisContainer }) => {
      for (const trickleCount of [6, 8]) {
        const opts: RunOpts = {
          trickleCount,
          maxCount: 5,
          calls: 60,
          backlogSize: 400,
          envLimit: 20,
        };
        const on = await runShape(redisContainer, `over-on-${trickleCount}`, true, opts);
        expect(on.totalServed).toBe(300);
        expectFairish(`trickle=${trickleCount}`, opts, on);
      }
    }
  );

  redisTest(
    "a concurrency-gated variant pinned at a low tag does not defeat it",
    async ({ redisContainer }) => {
      const opts: RunOpts = {
        trickleCount: 5,
        maxCount: 5,
        calls: 120,
        backlogSize: 400,
        envLimit: 20,
        gatedVariant: true,
      };
      const on = await runShape(redisContainer, "pin-gated-on", true, opts);

      // The gated variant is still registered and still holding a tag below the floor, which
      // is the state that defeated the earlier floor-only prototype.
      expect(on.finalTags["gated"]).toBeLessThan(Number(on.finalFloor));
      expectFairish("gated", opts, on);
    }
  );

  redisTest(
    "a future-headed variant pinned at a low tag does not defeat it",
    async ({ redisContainer }) => {
      const opts: RunOpts = {
        trickleCount: 5,
        maxCount: 5,
        calls: 120,
        backlogSize: 400,
        envLimit: 20,
        futureVariant: true,
      };
      const on = await runShape(redisContainer, "pin-future-on", true, opts);

      expect(on.finalTags["future"]).toBeLessThan(Number(on.finalFloor));
      expectFairish("future", opts, on);
    }
  );

  redisTest("both pinned-low variants at once", async ({ redisContainer }) => {
    const opts: RunOpts = {
      trickleCount: 5,
      maxCount: 5,
      calls: 120,
      backlogSize: 400,
      envLimit: 20,
      gatedVariant: true,
      futureVariant: true,
    };
    const on = await runShape(redisContainer, "pin-both-on", true, opts);
    expectFairish("gated+future", opts, on);
  });

  redisTest(
    "control: competitors with deep queues never drain, so they never re-registered",
    async ({ redisContainer }) => {
      const opts: RunOpts = {
        trickleCount: 5,
        maxCount: 5,
        calls: 120,
        backlogSize: 400,
        envLimit: 20,
        steadyCompetitors: true,
      };
      const on = await runShape(redisContainer, "steady-on", true, opts);

      // This shape never triggered the bug, so it measures what fair looks like: the
      // trickle shapes above are held to the same standard.
      expect(on.totalServed).toBe(600);
      expectFairish("steady", opts, on);

      // Nothing drained, so nothing was ever parked.
      expect(on.idleSize).toBe(0);
    }
  );

  // The idle set is trimmed two ways. The at-or-below-floor reap is the cheap one, but it
  // is worth nothing while the floor is pinned, and a workload that keeps minting fresh
  // concurrency keys pins it indefinitely: each new key registers at the floor and is
  // served at it, so minServableTag never rises. A resource benchmark caught the set
  // growing by the drain count every round and never shrinking. The rank cap is the bound
  // that does not depend on the floor moving.
  redisTest(
    "fresh keys advance the floor, and the idle set stays capped",
    async ({ redisContainer }) => {
      const CAP = 25;
      const DRAINS = 400;
      const keyPrefix = `runqueue:test:idlecap:`;
      const queue = createQueue(redisContainer, keyPrefix, true, CAP);

      try {
        const env = { ...baseEnv, maximumConcurrencyLimit: 20 };
        await queue.updateEnvConcurrencyLimits(env);
        const shard = testOptions.keys.masterQueueShardForEnvironment(env.id, 2);

        // Every iteration uses a concurrency key never seen before, drains it, and never
        // brings it back: the worst case for a set that remembers drained variants.
        for (let i = 0; i < DRAINS; i++) {
          await queue.enqueueMessage({
            env,
            message: makeMessage({ runId: `f-${i}`, concurrencyKey: `fresh-${i}` }),
            workerQueue: env.id,
            skipDequeueProcessing: true,
          });
          const msgs = await queue.testDequeueFromMasterQueue(shard, env.id, 1);
          for (const m of msgs) {
            await queue.acknowledgeMessage(env.organization.id, m.messageId, {
              skipDequeueProcessing: true,
            });
          }
        }

        const idleKey = testOptions.keys.ckVtimeIdleKeyFromQueue(variantName("fresh-0"));
        const idleSize = await queue.redis.zcard(idleKey);
        const floor = await queue.redis.get(
          testOptions.keys.ckVtimeFloorKeyFromQueue(variantName("fresh-0"))
        );

        // This test was written when a stream of fresh keys pinned the floor at 0 forever,
        // and it asserted exactly that, to show the rank cap was the only thing bounding
        // the idle set. Registering a fresh variant behind the pack rather than at the
        // floor removed the pinning, so the premise is gone and the floor now climbs with
        // service. That climb IS the fresh-key fix, so assert it rather than delete it.
        expect(Number(floor ?? 0)).toBeGreaterThan(0);
        // The set stays bounded either way. Both mechanisms now contribute: the
        // at-or-below-floor reap can finally fire, and the rank cap backstops it.
        // One call can park past the cap before the next trim, hence the small margin.
        expect(idleSize).toBeLessThanOrEqual(CAP + 10);
        expect(idleSize).toBeGreaterThan(0);
      } finally {
        await queue.quit();
      }
    }
  );
  // The idle set has two bounds: the at-or-below-floor score reap, and a hard rank cap.
  // The reap does the visible work now that the floor advances, which left the cap with no
  // test isolating it. It still matters, because a park only ever writes a tag ABOVE the
  // floor, so anything parked faster than the floor climbs is untouchable by the reap and
  // the cap is the only thing standing between that and unbounded growth. Seed the set
  // directly, well clear of the floor, so the reap provably cannot be what trims it.
  redisTest("the rank cap trims the idle set from the bottom", async ({ redisContainer }) => {
    const CAP = 10;
    const SEEDED = 200;
    const keyPrefix = `runqueue:test:rankcap:`;
    const queue = createQueue(redisContainer, keyPrefix, true, CAP);

    try {
      const env = { ...baseEnv, maximumConcurrencyLimit: 20 };
      await queue.updateEnvConcurrencyLimits(env);
      const shard = testOptions.keys.masterQueueShardForEnvironment(env.id, 2);

      // One ordinary servable variant, so the dequeue actually serves and the persist
      // block that carries the trim runs at all.
      await queue.enqueueMessage({
        env,
        message: makeMessage({ runId: "r-live", concurrencyKey: "live" }),
        workerQueue: env.id,
        skipDequeueProcessing: true,
      });

      const idleKey = testOptions.keys.ckVtimeIdleKeyFromQueue(variantName("live"));
      const floorKey = testOptions.keys.ckVtimeFloorKeyFromQueue(variantName("live"));

      // Scores from 1000 up, far above any floor this fixture can reach, so
      // ZREMRANGEBYSCORE -inf floor matches none of them.
      const seed: (string | number)[] = [];
      for (let i = 0; i < SEEDED; i++) seed.push(1000 + i, `${variantName("live")}-ghost-${i}`);
      await queue.redis.zadd(idleKey, ...(seed as [number, string]));
      expect(await queue.redis.zcard(idleKey)).toBe(SEEDED);

      const served = await queue.testDequeueFromMasterQueue(shard, env.id, 5);
      expect(served.length).toBe(1);

      const floor = Number((await queue.redis.get(floorKey)) ?? "0");
      const after = await queue.redis.zcard(idleKey);

      // The floor never reached the seeded scores, so the reap cannot explain the trim.
      expect(floor).toBeLessThan(1000);
      expect(after).toBeLessThanOrEqual(CAP + 1);
      expect(after).toBeGreaterThan(0);

      // Trimmed from the bottom: the survivors are the highest tags, which are the ones
      // holding the most remembered credit and so the most expensive to forget.
      const survivors = await queue.redis.zrange(idleKey, 0, -1, "WITHSCORES");
      const lowest = Number(survivors[1]);
      expect(lowest).toBeGreaterThanOrEqual(1000 + SEEDED - (CAP + 1));
    } finally {
      await queue.quit();
    }
  });
  // A workload minting a previously-unseen concurrency key per run pins the floor at the
  // epoch, so any variant that has ever been served sits above every arrival and loses
  // forever. Being served once must not be a permanent penalty.
  redisTest(
    "a persistent backlog survives a flood of brand-new keys",
    async ({ redisContainer }) => {
      const CALLS = 120;
      const MAX = 5;
      const FRESH_PER_CALL = 8; // above MAX on purpose: the overload case

      async function run(vtime: boolean) {
        const keyPrefix = `runqueue:test:freshflood:${vtime ? "on" : "off"}:`;
        const queue = createQueue(redisContainer, keyPrefix, vtime);
        try {
          const env = { ...baseEnv, maximumConcurrencyLimit: 50 };
          await queue.updateEnvConcurrencyLimits(env);
          const shard = testOptions.keys.masterQueueShardForEnvironment(env.id, 2);
          const t0 = Date.now() - 10_000_000;

          for (let i = 0; i < 400; i++) {
            await queue.enqueueMessage({
              env,
              message: makeMessage({
                runId: `b-${i}`,
                concurrencyKey: "backlog",
                timestamp: t0 + i,
              }),
              workerQueue: env.id,
              skipDequeueProcessing: true,
            });
          }

          let fresh = 0;
          let backlogServed = 0;
          for (let call = 0; call < CALLS; call++) {
            for (let f = 0; f < FRESH_PER_CALL; f++, fresh++) {
              await queue.enqueueMessage({
                env,
                message: makeMessage({
                  runId: `f-${fresh}`,
                  concurrencyKey: `fresh-${fresh}`,
                  timestamp: t0 + 5_000_000 + fresh,
                }),
                workerQueue: env.id,
                skipDequeueProcessing: true,
              });
            }
            for (const m of await queue.testDequeueFromMasterQueue(shard, env.id, MAX)) {
              if (m.message.concurrencyKey === "backlog") backlogServed++;
              await queue.acknowledgeMessage(env.organization.id, m.messageId, {
                skipDequeueProcessing: true,
              });
            }
          }
          const floor = Number(
            (await queue.redis.get(
              testOptions.keys.ckVtimeFloorKeyFromQueue(variantName("backlog"))
            )) ?? "0"
          );
          return { backlogServed, floor };
        } finally {
          await queue.quit();
        }
      }

      const on = await run(true);
      const off = await run(false);

      // Flag off is pure age order, so the always-oldest backlog wins a slot every call.
      expect(off.backlogServed).toBeGreaterThanOrEqual(100);
      // Flag on now keeps pace with it. Pre-fix this was 1.
      expect(on.backlogServed).toBeGreaterThanOrEqual(100);
      // And the floor moves, which is the actual repair: arrivals no longer enter at the
      // epoch, so virtual time tracks service instead of standing still.
      expect(on.floor).toBeGreaterThan(0);
    },
    120_000
  );

  // The arrival cap is a sanity clamp, and it is only safe while it stays out of reach.
  // Lowered into range it inverts: clamped arrivals stop stacking one quantum apart and
  // pile onto the cap line, the serving front crosses that dense band slower than the
  // floor rises, and the backlog's tag climbs into it and ties with the crowd. Nobody
  // caught this from a snapshot; it needs a sustained run to show up. Pinned here so the
  // default cannot be lowered back into reach without this failing.
  redisTest(
    "a reachable arrival cap restores the starvation it was meant to bound",
    async ({ redisContainer }) => {
      const CALLS = 300;
      const MAX = 5;
      const MINT = 40;

      async function run(label: string) {
        const queue = createQueue(redisContainer, `runqueue:test:cap${label}:`, true);
        try {
          const env = { ...baseEnv, maximumConcurrencyLimit: 200 };
          await queue.updateEnvConcurrencyLimits(env);
          const shard = testOptions.keys.masterQueueShardForEnvironment(env.id, 2);
          const t0 = Date.now() - 10_000_000;
          for (let i = 0; i < 2000; i++) {
            await queue.enqueueMessage({
              env,
              message: makeMessage({
                runId: `b-${i}`,
                concurrencyKey: "backlog",
                timestamp: t0 + i,
              }),
              workerQueue: env.id,
              skipDequeueProcessing: true,
            });
          }
          let minted = 0;
          let served = 0;
          for (let call = 0; call < CALLS; call++) {
            for (let f = 0; f < MINT; f++, minted++) {
              await queue.enqueueMessage({
                env,
                message: makeMessage({
                  runId: `m-${minted}`,
                  concurrencyKey: `mint-${minted}`,
                  timestamp: t0 + 5_000_000 + minted,
                }),
                workerQueue: env.id,
                skipDequeueProcessing: true,
              });
            }
            for (const m of await queue.testDequeueFromMasterQueue(shard, env.id, MAX)) {
              if (m.message.concurrencyKey === "backlog") served++;
              await queue.acknowledgeMessage(env.organization.id, m.messageId, {
                skipDequeueProcessing: true,
              });
            }
          }
          return served;
        } finally {
          await queue.quit();
        }
      }

      // Default cap, far out of reach: the backlog keeps its share under sustained minting.
      const atDefault = await run("def");
      expect(atDefault).toBeGreaterThanOrEqual(200);
    },
    600_000
  );
});
