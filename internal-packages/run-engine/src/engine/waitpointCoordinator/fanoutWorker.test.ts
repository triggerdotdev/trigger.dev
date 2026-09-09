/**
 * Bounded fanout and lifecycle cleanup, against a real Redis.
 *
 * Two rules hold across the file. Nothing waits on a clock: the worker is driven by
 * explicit `visit`/`runOnce` calls and lease expiry is expressed by handing it a later
 * `now`, so a "crash" and a "reclaim" are deterministic rather than a race with a poll
 * interval. And a crash is modelled by a hook that throws, which leaves exactly the state a
 * killed process would.
 */
import { createRedisClient, Redis, type RedisOptions } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import { createTestMetricsMeter } from "../tests/helpers/replicaTestHelpers.js";
import { fanoutRetryDelayMs } from "./fanoutPolicy.js";
import { WaitpointFanoutWorker, type FanoutWorkerHooks } from "./fanoutWorker.js";
import {
  edgeField,
  fanoutIndexKeys,
  fanoutPartition,
  waitpointKeys,
  watcherField,
} from "./keys.js";
import {
  MAX_INLINE_COMPLETION_OUTPUT_BYTES,
  WaitpointCompletionConflictError,
  WaitpointNotFoundError,
  WaitpointStoreCoordinator,
  type BlockEdge,
  type WaitpointCompletion,
  type WaitpointRecordInput,
} from "./storeCoordinator.js";

const ENV_ID = "env_1";
const PROJECT_ID = "proj_1";
const NOW = "2026-08-21T12:00:00.000Z";
const BLOCK = "blk_1";
const LEASE_MS = 30_000;
// The `pending-record` deferral. Named, because the tests assert the exact score the
// deferral lands on rather than "some time later".
const GRACE_MS = 5_000;
// Short enough to assert a positive PTTL without waiting for it, long enough that nothing
// expires mid-test.
const RETENTION_MS = 600_000;
// For the tests that drive releaseFanout directly. The script needs the curve, because it
// computes and stores the backoff atomically with the failure it counts.
const TEST_RETRY = { baseDelayMs: 1_000, maxDelayMs: 4_000 };

function coordinator(redisOptions: RedisOptions, overrides: { clock?: () => number } = {}) {
  return new WaitpointStoreCoordinator({
    redisOptions,
    terminalRetentionMs: RETENTION_MS,
    ...overrides,
  });
}

/**
 * An advancing clock. `visit` samples the clock at every claim, ack and release, so a test
 * that needs a lease to lapse advances this rather than handing one timestamp to a visit and
 * having every later operation inside it inherit that same instant.
 */
function fakeClock(start = Date.now()) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => (t += ms),
    set: (at: number) => (t = at),
  };
}

function worker(
  store: WaitpointStoreCoordinator,
  options: {
    workerId?: string;
    pageSize?: number;
    maxPagesPerVisit?: number;
    dueBatchSize?: number;
    hintGraceMs?: number;
    clock?: () => number;
    hooks?: FanoutWorkerHooks;
  } = {}
) {
  return new WaitpointFanoutWorker({
    coordinator: store,
    enabled: true,
    leaseMs: LEASE_MS,
    pageSize: options.pageSize ?? 100,
    maxPagesPerVisit: options.maxPagesPerVisit ?? 10,
    dueBatchSize: options.dueBatchSize ?? 50,
    hintGraceMs: options.hintGraceMs ?? 5_000,
    workerId: options.workerId ?? "worker-a",
    clock: options.clock,
    hooks: options.hooks,
  });
}

function record(id: string, overrides: Partial<WaitpointRecordInput> = {}): WaitpointRecordInput {
  return {
    id,
    friendlyId: `waitpoint_${id}`,
    type: "MANUAL",
    environmentId: ENV_ID,
    projectId: PROJECT_ID,
    createdAt: NOW,
    updatedAt: NOW,
    userProvidedIdempotencyKey: false,
    tags: [],
    ...overrides,
  };
}

function completion(overrides: Partial<WaitpointCompletion> = {}): WaitpointCompletion {
  return {
    completedAt: NOW,
    outputType: "application/json",
    outputIsError: false,
    output: { inline: '{"ok":true}' },
    ...overrides,
  };
}

function edge(waitpointId: string, batchIndex?: number): BlockEdge {
  return { waitpointId, batchIndex, createdAt: NOW, type: "MANUAL" };
}

async function pending(store: WaitpointStoreCoordinator, id: string) {
  await store.createIfAbsent({ record: record(id), status: "PENDING" });
}

/**
 * The watcher field a `blockRuns` registration lands on. Watchers are block-scoped, so a
 * test that overwrites or reads one straight off the hash has to name the block too.
 */
function blockedWatcherField(runId: string, batchIndex?: number | null) {
  return watcherField(runId, `${BLOCK}_${runId}`, batchIndex);
}

/** Block `runIds` on one pending waitpoint, each under its own block operation. */
async function blockRuns(store: WaitpointStoreCoordinator, waitpointId: string, runIds: string[]) {
  for (const runId of runIds) {
    await store.registerBlocks({
      runId,
      blockId: `${BLOCK}_${runId}`,
      edges: [edge(waitpointId)],
    });
  }
}

async function receiptFor(probe: Redis, runId: string, waitpointId: string) {
  return probe.hget(`wp:v1:run:{${runId}}:done`, waitpointId);
}

/** Claim a page and return its fence token, which every later transition has to quote. */
async function claimEpoch(
  store: WaitpointStoreCoordinator,
  waitpointId: string,
  workerId: string,
  now?: number
): Promise<string> {
  const claim = await store.claimFanoutPage({
    waitpointId,
    workerId,
    pageSize: 10,
    leaseMs: LEASE_MS,
    now,
  });
  if (claim.outcome !== "claimed") {
    throw new Error(`claimEpoch(${waitpointId}): expected a claim, got ${claim.outcome}`);
  }
  return claim.epoch;
}

/**
 * `count` waitpoint ids that all hash to `partition`. The partition of an id is fixed by
 * FNV-1a, so a test that needs several entries competing inside ONE partition's bounded due
 * query has to search for ids rather than name them.
 */
function idsInPartition(partition: number, count: number, prefix: string): string[] {
  const found: string[] = [];
  for (let i = 0; found.length < count; i++) {
    const id = `${prefix}${i}`;
    if (fanoutPartition(id) === partition) {
      found.push(id);
    }
  }
  return found;
}

describe("completion with no watchers", () => {
  redisTest("owes no fanout and files no index entry", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await pending(store, "w_a");
      const result = await store.complete({ waitpointId: "w_a", completion: completion() });

      expect(result.fanout).toBe("absent");
      expect(await probe.exists(waitpointKeys("w_a").fanout)).toBe(0);

      // The hint filed before the flip is retired on the fast path, so a worker sweep finds
      // nothing at all to do.
      const tick = await worker(store).runOnce();
      expect(tick.scanned).toBe(0);
      expect(tick.visits).toEqual([]);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });
});

describe("completion with one watcher", () => {
  redisTest("delivers, drains, and arms the record's terminal TTL", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await pending(store, "w_a");
      await blockRuns(store, "w_a", ["run_1"]);

      const completed = await store.complete({ waitpointId: "w_a", completion: completion() });
      expect(completed.fanout).toBe("pending");
      // Nothing is delivered by the foreground call.
      expect(await receiptFor(probe, "run_1", "w_a")).toBeNull();

      const tick = await worker(store).runOnce();
      expect(tick.visits).toHaveLength(1);
      expect(tick.visits[0]).toMatchObject({ delivered: 1, outcome: "drained", pages: 1 });

      expect(JSON.parse((await receiptFor(probe, "run_1", "w_a"))!)).toEqual(completion());
      expect(await probe.scard("wp:v1:run:{run_1}:pend")).toBe(0);

      const keys = waitpointKeys("w_a");
      // Watcher state compacted, record retained for the terminal window.
      expect(await probe.exists(keys.watchers)).toBe(0);
      expect(await probe.exists(keys.queue)).toBe(0);
      expect(await probe.pttl(keys.record)).toBeGreaterThan(0);
      expect(await probe.pttl(keys.record)).toBeLessThanOrEqual(RETENTION_MS);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("files the entry in the partition its id hashes to", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await pending(store, "w_a");
      await blockRuns(store, "w_a", ["run_1"]);
      await store.complete({ waitpointId: "w_a", completion: completion() });

      // Discovery is by fixed partition, never by scanning the keyspace.
      const partition = fanoutPartition("w_a");
      expect(await probe.zscore(fanoutIndexKeys(partition).due, "w_a")).not.toBeNull();
      expect(
        await store.dueFanoutEntries({ partition, limit: 10, now: Date.now() + 1_000 })
      ).toEqual(["w_a"]);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });
});

describe("more watchers than one page", () => {
  redisTest("drains in bounded pages, never in one read", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      const runIds = Array.from({ length: 7 }, (_, i) => `run_${i}`);
      await pending(store, "w_a");
      await blockRuns(store, "w_a", runIds);
      await store.complete({ waitpointId: "w_a", completion: completion() });

      // 3 per page, 2 pages per visit: the first visit is allowed 6 of the 7.
      const fanoutWorker = worker(store, { pageSize: 3, maxPagesPerVisit: 2 });

      const first = await fanoutWorker.visit("w_a");
      expect(first).toMatchObject({ pages: 2, delivered: 6, outcome: "more" });
      expect(await probe.llen(waitpointKeys("w_a").queue)).toBe(1);

      const second = await fanoutWorker.visit("w_a");
      expect(second).toMatchObject({ pages: 1, delivered: 1, outcome: "drained" });

      for (const runId of runIds) {
        expect(await receiptFor(probe, runId, "w_a")).not.toBeNull();
      }
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("a claimed page never exceeds the requested size", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await pending(store, "w_a");
      await blockRuns(
        store,
        "w_a",
        Array.from({ length: 40 }, (_, i) => `run_${i}`)
      );
      await store.complete({ waitpointId: "w_a", completion: completion() });

      const claim = await store.claimFanoutPage({
        waitpointId: "w_a",
        workerId: "worker-a",
        pageSize: 5,
        leaseMs: LEASE_MS,
      });

      expect(claim.outcome).toBe("claimed");
      expect(claim.outcome === "claimed" && claim.page).toHaveLength(5);
    } finally {
      await store.quit();
    }
  });
});

describe("registration ordering", () => {
  redisTest(
    "registration after completion returns the frozen envelope and owes no fanout",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await store.complete({ waitpointId: "w_a", completion: completion() });

        const result = await store.registerBlocks({
          runId: "run_late",
          blockId: BLOCK,
          edges: [edge("w_a")],
        });

        // Never pending, and the receipt is already on the run's shard.
        expect(result.pendingOfRequested).toBe(0);
        expect(result.alreadyDelivered).toEqual([{ waitpointId: "w_a", completion: completion() }]);
        expect(await probe.exists(waitpointKeys("w_a").queue)).toBe(0);
        expect(await probe.exists(waitpointKeys("w_a").fanout)).toBe(0);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "registration before completion is delivered by the worker",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        const blocked = await store.registerBlocks({
          runId: "run_1",
          blockId: BLOCK,
          edges: [edge("w_a")],
        });
        expect(blocked.pendingOfRequested).toBe(1);

        await store.complete({ waitpointId: "w_a", completion: completion() });
        await worker(store).runOnce();

        expect(await receiptFor(probe, "run_1", "w_a")).not.toBeNull();
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "a late registration after the fanout has drained still completes immediately",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });
        expect((await worker(store).runOnce()).visits[0]).toMatchObject({ outcome: "drained" });

        const late = await store.registerOrReport({
          waitpointId: "w_a",
          runId: "run_late",
          blockId: BLOCK,
          createdAt: NOW,
        });

        expect(late.outcome).toBe("completed");
        expect(late.completion).toEqual(completion());
        // The drained fanout is not restarted, and no watcher is queued behind it.
        expect(await probe.exists(waitpointKeys("w_a").queue)).toBe(0);
        expect(await probe.hget(waitpointKeys("w_a").fanout, "state")).toBe("done");
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "a duplicate equivalent completion does not restart a drained fanout",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });
        await worker(store).runOnce();

        const again = await store.complete({
          waitpointId: "w_a",
          completion: completion({ completedAt: "2026-08-21T13:00:00.000Z" }),
        });

        expect(again.outcome).toBe("already");
        expect(again.fanout).toBe("done");
        // The duplicate files a hint before the flip, as every completion does, and then
        // retires it on seeing there is nothing owed. So the next sweep finds no work at
        // all rather than revisiting a drained entry.
        expect((await worker(store).runOnce()).visits).toEqual([]);
      } finally {
        await store.quit();
      }
    }
  );
});

describe("delivery idempotency", () => {
  redisTest("a second delivery is a duplicate and rewrites nothing", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await store.absorbBlockers({ runId: "run_1", blockId: BLOCK, edges: [edge("w_a")] });

      const first = await store.deliverCompletion({
        runId: "run_1",
        blockId: BLOCK,
        waitpointId: "w_a",
        completion: completion(),
      });
      const second = await store.deliverCompletion({
        runId: "run_1",
        blockId: BLOCK,
        waitpointId: "w_a",
        completion: completion({ output: { inline: '{"different":true}' } }),
      });

      expect(first.outcome).toBe("delivered");
      expect(first.resumable).toBe(true);
      expect(second.outcome).toBe("duplicate");
      // One effective receipt, holding the FIRST envelope.
      expect(JSON.parse((await receiptFor(probe, "run_1", "w_a"))!)).toEqual(completion());
      expect(await probe.hlen("wp:v1:run:{run_1}:done")).toBe(1);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest(
    "a stale delivery cannot clear or wake a newer block operation",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await pending(store, "w_b");

        // Block operation one: registered on w_a, then completed but never delivered.
        await store.registerBlocks({ runId: "run_1", blockId: "blk_one", edges: [edge("w_a")] });
        await store.complete({ waitpointId: "w_a", completion: completion() });
        await store.clearBlockState({
          runId: "run_1",
          blockId: "blk_one",
          edgeIds: [edgeField("w_a")],
        });

        // Block operation two: a different blocker entirely.
        await store.registerBlocks({
          runId: "run_1",
          blockId: "blk_two",
          edges: [edge("w_b")],
          expectedPreviousBlockId: "blk_one",
        });

        const tick = await worker(store).runOnce();

        expect(tick.visits[0]).toMatchObject({ rejected: 1, delivered: 0, outcome: "drained" });
        // run_1 is still blocked on w_b, has no receipt for w_a, and owes no handoff.
        expect(await probe.smembers("wp:v1:run:{run_1}:pend")).toEqual(["w_b"]);
        expect(await receiptFor(probe, "run_1", "w_a")).toBeNull();
        expect((await store.readBlockState("run_1")).handoff).toBe("none");
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest("a completion arriving before absorption is preserved", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      // No block id installed yet: an early delivery is not stale, and its receipt has to
      // survive for the absorb to subtract it.
      const early = await store.deliverCompletion({
        runId: "run_1",
        blockId: BLOCK,
        waitpointId: "w_a",
        completion: completion(),
      });
      expect(early.outcome).toBe("delivered");
      expect(early.resumable).toBe(false);

      const absorbed = await store.absorbBlockers({
        runId: "run_1",
        blockId: BLOCK,
        edges: [edge("w_a")],
      });
      expect(absorbed.pendingOfRequested).toBe(0);
      expect(absorbed.alreadyDelivered).toEqual([{ waitpointId: "w_a", completion: completion() }]);
    } finally {
      await store.quit();
    }
  });
});

describe("worker failure and reclaiming", () => {
  redisTest("a crash before delivering loses no wake-up", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const clock = fakeClock();
    const probe = createRedisClient(redisOptions);
    try {
      await pending(store, "w_a");
      await blockRuns(store, "w_a", ["run_1"]);
      await store.complete({ waitpointId: "w_a", completion: completion() });

      const crashing = worker(store, {
        clock: clock.now,
        workerId: "worker-crash",
        hooks: {
          onPageClaimed: async () => {
            throw new Error("killed before delivering");
          },
        },
      });

      // The clock starts where the fixture finished, so the entry's own notBefore is
      // already in the past and the claim is due.
      const now = Date.now();
      clock.set(now);

      await expect(crashing.visit("w_a")).rejects.toThrow("killed before delivering");
      expect(await receiptFor(probe, "run_1", "w_a")).toBeNull();
      // The queue is untouched and the claim is still held, so the work is intact.
      expect(await probe.llen(waitpointKeys("w_a").queue)).toBe(1);
      expect(await probe.hget(waitpointKeys("w_a").fanout, "owner")).toBe("worker-crash");

      // A second worker cannot steal a live claim.
      const survivor = worker(store, { clock: clock.now, workerId: "worker-b" });
      expect(await survivor.visit("w_a")).toMatchObject({ outcome: "busy" });

      // Once the lease has lapsed it reclaims and delivers.
      clock.set(now + LEASE_MS + 1);
      const reclaimed = await survivor.visit("w_a");
      expect(reclaimed).toMatchObject({ delivered: 1, outcome: "drained" });
      expect(await receiptFor(probe, "run_1", "w_a")).not.toBeNull();
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest(
    "a crash after delivering but before acknowledging redelivers exactly once in effect",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const clock = fakeClock();
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });

        const crashing = worker(store, {
          clock: clock.now,
          workerId: "worker-crash",
          hooks: {
            beforeAck: async () => {
              throw new Error("killed before acknowledging");
            },
          },
        });

        const now = Date.now();
        clock.set(now);

        await expect(crashing.visit("w_a")).rejects.toThrow("killed before acknowledging");
        // The delivery DID happen; only the acknowledgement was lost.
        expect(await receiptFor(probe, "run_1", "w_a")).not.toBeNull();
        expect(await probe.llen(waitpointKeys("w_a").queue)).toBe(1);

        const survivor = worker(store, { clock: clock.now, workerId: "worker-b" });
        clock.set(now + LEASE_MS + 1);
        const redelivered = await survivor.visit("w_a");

        // At-least-once delivery, idempotent effect: the redelivery is a duplicate and the
        // run still holds exactly one receipt.
        expect(redelivered).toMatchObject({ duplicates: 1, delivered: 0, outcome: "drained" });
        expect(await probe.hlen("wp:v1:run:{run_1}:done")).toBe(1);
        expect(JSON.parse((await receiptFor(probe, "run_1", "w_a"))!)).toEqual(completion());
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "a worker whose claim was reclaimed cannot trim the new owner's page",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });

        const slowEpoch = await claimEpoch(store, "w_a", "worker-slow");
        // The lease lapses and a second worker takes over, raising the fence.
        const fastEpoch = await claimEpoch(store, "w_a", "worker-fast", Date.now() + LEASE_MS + 1);
        expect(fastEpoch).not.toBe(slowEpoch);

        const lost = await store.acknowledgeFanoutPage({
          waitpointId: "w_a",
          workerId: "worker-slow",
          epoch: slowEpoch,
          count: 1,
        });
        expect(lost).toEqual({ outcome: "lost", owner: "worker-fast" });

        const kept = await store.acknowledgeFanoutPage({
          waitpointId: "w_a",
          workerId: "worker-fast",
          epoch: fastEpoch,
          count: 1,
        });
        expect(kept).toMatchObject({ outcome: "drained" });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "a failed delivery retries with backoff, and quarantines rather than spinning",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const clock = fakeClock();
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });

        // An UNROUTABLE watcher: an empty run id yields `wp:v1:run:{}:...`, which carries no
        // hash tag, so the coordinator's own single-slot guard rejects the delivery. That
        // throws where a real unreachable shard would, which is the retryable branch —
        // unlike a withdrawn registration, which is terminal.
        const keys = waitpointKeys("w_a");
        await probe.hset(
          keys.watchers,
          blockedWatcherField("run_1"),
          JSON.stringify({ runId: "", blockId: BLOCK, createdAt: NOW })
        );

        const failing = new WaitpointFanoutWorker({
          clock: clock.now,
          coordinator: store,
          enabled: true,
          workerId: "worker-a",
          leaseMs: LEASE_MS,
          retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 4_000, maxFailures: 3 },
        });

        const now = Date.now();
        clock.set(now);
        expect(await failing.visit("w_a")).toMatchObject({ outcome: "released" });
        const partition = fanoutPartition("w_a");
        // Rescheduled into the future, so a sweep at `now` no longer sees it.
        expect(await store.dueFanoutEntries({ partition, limit: 10, now })).toEqual([]);
        expect(await store.dueFanoutEntries({ partition, limit: 10, now: now + 60_000 })).toEqual([
          "w_a",
        ]);

        clock.set(now + 60_000);
        expect(await failing.visit("w_a")).toMatchObject({ outcome: "released" });
        // The failure streak, not the claim count, is what the give-up threshold reads.
        expect(await probe.hget(keys.fanout, "fail")).toBe("2");
        clock.set(now + 120_000);
        expect(await failing.visit("w_a")).toMatchObject({
          outcome: "quarantined",
        });

        // Unresolved recovery state, and therefore no TTL: it must still be here tomorrow.
        expect(await probe.hget(keys.fanout, "state")).toBe("quarantined");
        expect(await probe.pttl(keys.fanout)).toBe(-1);
        expect(await probe.pttl(keys.record)).toBe(-1);
        expect(await probe.zscore(fanoutIndexKeys(partition).quarantine, "w_a")).not.toBeNull();
        expect(await store.dueFanoutEntries({ partition, limit: 10, now: now + 1e9 })).toEqual([]);

        const backlog = await store.fanoutBacklog();
        expect(backlog).toMatchObject({ due: 0, quarantined: 1 });
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "a stall late in a wide fan-out retries; the page count is not the give-up budget",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        const runIds = Array.from({ length: 12 }, (_, i) => `run_${i}`);
        await blockRuns(store, "w_a", runIds);
        await store.complete({ waitpointId: "w_a", completion: completion() });

        // The last watcher is unroutable, so the sixth and final page stalls.
        await probe.hset(
          waitpointKeys("w_a").watchers,
          blockedWatcherField("run_11"),
          JSON.stringify({ runId: "", blockId: BLOCK, createdAt: NOW })
        );

        // Six pages against a give-up threshold of three. The threshold counts CONSECUTIVE
        // FAILURES, and five pages of progress reset it — measuring it against the claim
        // count instead would quarantine this drain on its first stall.
        const paged = new WaitpointFanoutWorker({
          coordinator: store,
          enabled: true,
          workerId: "worker-a",
          pageSize: 2,
          maxPagesPerVisit: 6,
          leaseMs: LEASE_MS,
          retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 4_000, maxFailures: 3 },
        });

        const summary = await paged.visit("w_a");
        expect(summary).toMatchObject({ pages: 6, delivered: 11, outcome: "released" });
        const fanout = waitpointKeys("w_a").fanout;
        // Six claims taken, exactly one counted as a failure.
        expect(await probe.hget(fanout, "att")).toBe("6");
        expect(await probe.hget(fanout, "fail")).toBe("1");
        expect(await probe.hget(fanout, "state")).toBe("pending");
        // And the eleven deliveries that did land are retired, so a retry redelivers one.
        expect(await probe.llen(waitpointKeys("w_a").queue)).toBe(1);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest("acknowledged progress clears an earlier failure streak", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await pending(store, "w_a");
      await blockRuns(store, "w_a", ["run_1"]);
      await store.complete({ waitpointId: "w_a", completion: completion() });

      const failEpoch = await claimEpoch(store, "w_a", "worker-a");
      const failed = await store.releaseFanout({
        waitpointId: "w_a",
        workerId: "worker-a",
        epoch: failEpoch,
        action: "fail",
        maxFailures: 5,
        retryPolicy: TEST_RETRY,
      });
      expect(failed).toMatchObject({ outcome: "released", failures: 1 });

      // The failure stored a backoff, so the next claim has to be past it.
      const ackEpoch = await claimEpoch(store, "w_a", "worker-a", Date.now() + 60_000);
      await store.acknowledgeFanoutPage({
        waitpointId: "w_a",
        workerId: "worker-a",
        epoch: ackEpoch,
        count: 1,
      });
      expect(await probe.hget(waitpointKeys("w_a").fanout, "fail")).toBe("0");
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("a spurious index hint is retired, not retried forever", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      // What a crash between filing the hint and flipping the completion leaves behind.
      await store.scheduleFanoutVisit("w_never", Date.now());
      const partition = fanoutPartition("w_never");

      const tick = await worker(store).runOnce();
      expect(tick.visits).toHaveLength(1);
      expect(tick.visits[0]!.outcome).toBe("absent");
      expect(await probe.zscore(fanoutIndexKeys(partition).due, "w_never")).toBeNull();
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });
});

describe("the hint-before-flip window", () => {
  redisTest(
    "a worker sweeping before the flip keeps the hint, and the fanout still drains",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        // Exactly the state `complete` is in between filing its hint and flipping the
        // record: hint present, watcher queued, record still PENDING.
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.scheduleFanoutVisit("w_a", Date.now());

        const partition = fanoutPartition("w_a");
        const swept = await worker(store).runOnce();

        // Retiring the hint here is what would strand the entry the flip is about to make.
        expect(swept.visits).toHaveLength(1);
        expect(swept.visits[0]!.outcome).toBe("pending-record");
        expect(await probe.zscore(fanoutIndexKeys(partition).due, "w_a")).not.toBeNull();

        // Now the flip lands, and the deferred hint is still there to be found.
        await store.complete({ waitpointId: "w_a", completion: completion() });
        const drained = await worker(store).runOnce(Date.now() + 60_000);

        expect(drained.visits[0]).toMatchObject({ delivered: 1, outcome: "drained" });
        expect(await receiptFor(probe, "run_1", "w_a")).not.toBeNull();
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "a sweep in the pre-flip window defers the hint by a bounded grace, never deletes it",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const clock = fakeClock();
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);

        const base = Date.now();
        clock.set(base);
        await store.scheduleFanoutVisit("w_a", base);
        const due = fanoutIndexKeys(fanoutPartition("w_a")).due;
        expect(
          (await worker(store, { clock: clock.now, hintGraceMs: GRACE_MS }).runOnce(base))
            .visits[0]!.outcome
        ).toBe("pending-record");

        // Deferred, not deleted: the entry the flip is about to create must still be
        // reachable, so the score moves forward by exactly the grace and the member stays.
        expect(Number(await probe.zscore(due, "w_a"))).toBe(base + GRACE_MS);

        // And the flip overrides the deferral, so a completion racing the sweep does not
        // pay the grace: its own unconditional add lands on its `now`.
        await store.complete({ waitpointId: "w_a", completion: completion() });
        expect(Number(await probe.zscore(due, "w_a"))).toBeLessThan(base + GRACE_MS);
        expect((await worker(store).runOnce(Date.now() + 1_000)).visits[0]).toMatchObject({
          delivered: 1,
          outcome: "drained",
        });
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest("a hint for a record that never existed is retired", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await store.scheduleFanoutVisit("w_ghost", Date.now());

      const tick = await worker(store).runOnce();
      expect(tick.visits[0]!.outcome).toBe("absent");
      expect(
        await probe.zscore(fanoutIndexKeys(fanoutPartition("w_ghost")).due, "w_ghost")
      ).toBeNull();
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });
});

describe("the release-before-quarantine window", () => {
  redisTest(
    "a worker whose claim was reclaimed can neither count a failure nor quarantine",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });
        const keys = waitpointKeys("w_a");

        const slowEpoch = await claimEpoch(store, "w_a", "worker-slow");
        // The lease lapses and a second worker takes over. This is the gap the old
        // two-call release/quarantine sequence exposed.
        await claimEpoch(store, "w_a", "worker-fast", Date.now() + LEASE_MS + 1);

        const lost = await store.releaseFanout({
          waitpointId: "w_a",
          workerId: "worker-slow",
          epoch: slowEpoch,
          action: "fail",
          maxFailures: 1,
          retryPolicy: TEST_RETRY,
        });

        expect(lost).toEqual({ outcome: "lost", owner: "worker-fast" });
        // Nothing of the loser's is recorded: no failure counted, no quarantine, and the
        // live claim is left intact.
        expect(await probe.hget(keys.fanout, "fail")).toBeNull();
        expect(await probe.hget(keys.fanout, "state")).toBe("pending");
        expect(await probe.hget(keys.fanout, "owner")).toBe("worker-fast");
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  // End-to-end companion to the targeted test above: it asserts the INVARIANT the race
  // broke — a pending fanout entry is always in exactly one of the two indexes — rather
  // than reproducing the interleaving, which the single atomic release makes unreachable.
  redisTest(
    "two workers racing a failing delivery never strand the entry outside the index",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const clock = fakeClock();
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });
        // Unroutable, so every delivery attempt stalls rather than being refused.
        await probe.hset(
          waitpointKeys("w_a").watchers,
          blockedWatcherField("run_1"),
          JSON.stringify({ runId: "", blockId: BLOCK, createdAt: NOW })
        );

        const options = {
          clock: clock.now,
          coordinator: store,
          enabled: true,
          leaseMs: LEASE_MS,
          retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 4_000, maxFailures: 2 },
        };
        const slow = new WaitpointFanoutWorker({ ...options, workerId: "worker-slow" });
        const fast = new WaitpointFanoutWorker({ ...options, workerId: "worker-fast" });

        const now = Date.now();
        // slow claims and fails, so the entry is unowned with one failure recorded.
        clock.set(now);
        expect(await slow.visit("w_a")).toMatchObject({ outcome: "released" });
        expect(await probe.hget(waitpointKeys("w_a").fanout, "fail")).toBe("1");

        // fast claims next. slow, believing it still owns the entry, tries again.
        await claimEpoch(store, "w_a", "worker-fast", now + 60_000);
        clock.set(now + 60_001);
        expect(await slow.visit("w_a")).toMatchObject({ outcome: "busy" });

        // The entry is still pending and still discoverable — the invariant the race broke.
        const partition = fanoutPartition("w_a");
        expect(await probe.hget(waitpointKeys("w_a").fanout, "state")).toBe("pending");
        expect(await probe.zscore(fanoutIndexKeys(partition).due, "w_a")).not.toBeNull();
        expect(await probe.zscore(fanoutIndexKeys(partition).quarantine, "w_a")).toBeNull();

        // And fast, the real owner, is the one that reaches the threshold.
        clock.set(now + 120_000);
        expect(await fast.visit("w_a")).toMatchObject({
          outcome: "quarantined",
        });
        expect(await probe.zscore(fanoutIndexKeys(partition).quarantine, "w_a")).not.toBeNull();
        expect(await probe.zscore(fanoutIndexKeys(partition).due, "w_a")).toBeNull();
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest("the give-up threshold fires at exactly maxFailures", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await pending(store, "w_a");
      await blockRuns(store, "w_a", ["run_1"]);
      await store.complete({ waitpointId: "w_a", completion: completion() });

      // Each attempt claims past the previous failure's stored backoff.
      let at = Date.now();
      const fail = async () => {
        at += 60_000;
        return store.releaseFanout({
          waitpointId: "w_a",
          workerId: "worker-a",
          epoch: await claimEpoch(store, "w_a", "worker-a", at),
          action: "fail",
          maxFailures: 3,
          retryPolicy: TEST_RETRY,
          now: at,
        });
      };

      expect(await fail()).toMatchObject({ outcome: "released", failures: 1 });
      expect(await fail()).toMatchObject({ outcome: "released", failures: 2 });
      expect(await fail()).toMatchObject({ outcome: "quarantined", failures: 3 });
    } finally {
      await store.quit();
    }
  });
});

describe("replayed commands", () => {
  // ioredis resends an unfulfilled command when a connection drops after Redis has already
  // executed it but before the reply arrived (autoResendUnfulfilledCommands). Every
  // transition below is therefore reachable twice with identical arguments, which is what
  // these tests issue directly — no fault injection needed, because the second call is
  // indistinguishable from the resend.
  redisTest(
    "a repeated acknowledgement trims one prefix, and the rest is still delivered",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        const runIds = Array.from({ length: 6 }, (_, i) => `run_${i}`);
        await pending(store, "w_a");
        await blockRuns(store, "w_a", runIds);
        await store.complete({ waitpointId: "w_a", completion: completion() });
        const queue = waitpointKeys("w_a").queue;

        const epoch = await claimEpoch(store, "w_a", "worker-a");
        // An acknowledgement stands for deliveries that already happened, so make them.
        for (const runId of runIds.slice(0, 2)) {
          await store.deliverCompletion({
            runId,
            blockId: `${BLOCK}_${runId}`,
            waitpointId: "w_a",
            completion: completion(),
          });
        }

        const first = await store.acknowledgeFanoutPage({
          waitpointId: "w_a",
          workerId: "worker-a",
          epoch,
          count: 2,
        });
        expect(first).toEqual({ outcome: "more", remaining: 4 });
        expect(await probe.llen(queue)).toBe(4);

        // The resend. No fresh claim, identical arguments: a second LTRIM here would retire
        // two watchers nobody has delivered to.
        const replay = await store.acknowledgeFanoutPage({
          waitpointId: "w_a",
          workerId: "worker-a",
          epoch,
          count: 2,
        });
        expect(replay).toEqual({ outcome: "more", remaining: 4 });
        expect(await probe.llen(queue)).toBe(4);
        expect(await probe.hget(waitpointKeys("w_a").fanout, "del")).toBe("2");

        // And the four survivors are delivered, so nothing was lost to the replay.
        expect(await worker(store).visit("w_a")).toMatchObject({
          delivered: 4,
          outcome: "drained",
        });
        for (const runId of runIds) {
          expect(await receiptFor(probe, runId, "w_a")).not.toBeNull();
        }
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "a repeated final acknowledgement stays drained without re-arming the window",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });

        const epoch = await claimEpoch(store, "w_a", "worker-a");
        const args = { waitpointId: "w_a", workerId: "worker-a", epoch, count: 1 } as const;
        expect(await store.acknowledgeFanoutPage(args)).toEqual({
          outcome: "drained",
          delivered: 1,
        });
        const armedAt = await probe.pttl(waitpointKeys("w_a").record);

        expect(await store.acknowledgeFanoutPage(args)).toEqual({
          outcome: "drained",
          delivered: 1,
        });
        // Idempotent, and the terminal window is not pushed out by the replay.
        expect(await probe.pttl(waitpointKeys("w_a").record)).toBeLessThanOrEqual(armedAt);
        expect(await probe.hget(waitpointKeys("w_a").fanout, "del")).toBe("1");
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest("a repeated failed release counts the stall once", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await pending(store, "w_a");
      await blockRuns(store, "w_a", ["run_1"]);
      await store.complete({ waitpointId: "w_a", completion: completion() });
      const fanout = waitpointKeys("w_a").fanout;

      const epoch = await claimEpoch(store, "w_a", "worker-a");
      const args = {
        waitpointId: "w_a",
        workerId: "worker-a",
        epoch,
        action: "fail",
        maxFailures: 2,
        retryPolicy: TEST_RETRY,
      } as const;

      const first = await store.releaseFanout(args);
      expect(first).toMatchObject({ outcome: "released", failures: 1 });
      // The resend. Counting it would take the streak to 2 and quarantine on a single stall,
      // and it must report the SAME authoritative backoff rather than computing a new one.
      expect(await store.releaseFanout(args)).toEqual(first);
      expect(await probe.hget(fanout, "fail")).toBe("1");
      expect(await probe.hget(fanout, "state")).toBe("pending");

      // The NEXT claim's failure is a genuine second stall, and reaches the threshold.
      const next = await claimEpoch(store, "w_a", "worker-a", Date.now() + 60_000);
      const quarantined = await store.releaseFanout({ ...args, epoch: next });
      expect(quarantined).toMatchObject({ outcome: "quarantined", failures: 2 });
      // Replaying the quarantining release reports the same transition, once.
      expect(await store.releaseFanout({ ...args, epoch: next })).toEqual(quarantined);
      expect(await probe.hget(fanout, "fail")).toBe("2");
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });
});

// NOT a transport replay: this drives the worker's ordinary path twice. It is the
// partial-prefix companion to the tests above, covering the sequence a fence has to keep
// working — acknowledge the delivered prefix, count one stall, back off, retry the rest.
describe("a partial page followed by a stall", () => {
  redisTest(
    "a successful prefix then a failure trims once, counts one stall, and retries the rest",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const clock = fakeClock();
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_ok_1", "run_ok_2", "run_bad", "run_tail"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });

        // The third watcher is unroutable, so the page delivers a prefix of two and stalls.
        await probe.hset(
          waitpointKeys("w_a").watchers,
          blockedWatcherField("run_bad"),
          JSON.stringify({ runId: "", blockId: BLOCK, createdAt: NOW })
        );

        const stalling = new WaitpointFanoutWorker({
          clock: clock.now,
          coordinator: store,
          enabled: true,
          workerId: "worker-a",
          pageSize: 4,
          leaseMs: LEASE_MS,
          deliveryConcurrency: 1,
          retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 4_000, maxFailures: 5 },
        });

        const now = Date.now();
        // Three of the four deliver; only the contiguous prefix BEFORE the stall can be
        // retired, so the tail is delivered and stays queued for a redelivery.
        clock.set(now);
        expect(await stalling.visit("w_a")).toMatchObject({
          delivered: 3,
          failures: 1,
          outcome: "released",
        });

        const fanout = waitpointKeys("w_a").fanout;
        // Exactly the acknowledgeable prefix retired, exactly one stall counted, and the
        // failed watcher left at the head for the retry.
        expect(await probe.llen(waitpointKeys("w_a").queue)).toBe(2);
        expect(await probe.lindex(waitpointKeys("w_a").queue, 0)).toBe(
          blockedWatcherField("run_bad")
        );
        expect(await probe.hget(fanout, "del")).toBe("2");
        expect(await probe.hget(fanout, "fail")).toBe("1");
        expect(await probe.hget(fanout, "state")).toBe("pending");

        // Repair the watcher; the backoff window opens and the remainder drains.
        await probe.hset(
          waitpointKeys("w_a").watchers,
          blockedWatcherField("run_bad"),
          JSON.stringify({ runId: "run_bad", blockId: `${BLOCK}_run_bad`, createdAt: NOW })
        );
        await store.absorbBlockers({
          runId: "run_bad",
          blockId: `${BLOCK}_run_bad`,
          edges: [edge("w_a")],
        });

        clock.set(now + 60_000);

        expect(await stalling.visit("w_a")).toMatchObject({
          delivered: 1,
          duplicates: 1,
          outcome: "drained",
        });
        for (const runId of ["run_ok_1", "run_ok_2", "run_bad", "run_tail"]) {
          expect(await receiptFor(probe, runId, "w_a")).not.toBeNull();
        }
        // Progress reset the streak rather than carrying the earlier stall forward.
        expect(await probe.hget(fanout, "fail")).toBe("0");
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );
});

describe("duplicate completion and fanout backoff", () => {
  async function stall(store: WaitpointStoreCoordinator, probe: Redis, waitpointId: string) {
    // An unroutable watcher: an empty run id yields a key with no hash tag, so the
    // coordinator's own single-slot guard rejects the delivery — the retryable branch.
    await probe.hset(
      waitpointKeys(waitpointId).watchers,
      blockedWatcherField("run_1"),
      JSON.stringify({ runId: "", blockId: BLOCK, createdAt: NOW })
    );
  }

  redisTest(
    "an equivalent duplicate does not move the backoff earlier",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const clock = fakeClock();
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });
        await stall(store, probe, "w_a");

        const due = fanoutIndexKeys(fanoutPartition("w_a")).due;
        const now = Date.now();
        clock.set(now);
        expect(await worker(store, { clock: clock.now }).visit("w_a")).toMatchObject({
          outcome: "released",
        });
        const backoff = Number(await probe.zscore(due, "w_a"));
        expect(backoff).toBeGreaterThan(now);

        // A retry of the same completion. It has no standing to reschedule work that is
        // already backing off; pulling it forward would run the failed delivery at poll speed
        // and burn the failure budget before the configured delays.
        const again = await store.complete({
          waitpointId: "w_a",
          completion: completion({ completedAt: "2026-08-21T13:00:00.000Z" }),
        });
        expect(again.outcome).toBe("already");
        expect(Number(await probe.zscore(due, "w_a"))).toBe(backoff);
        expect(await probe.hget(waitpointKeys("w_a").fanout, "fail")).toBe("1");
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "a conflicting completion does not move the backoff earlier",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const clock = fakeClock();
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });
        await stall(store, probe, "w_a");

        const due = fanoutIndexKeys(fanoutPartition("w_a")).due;
        clock.set(Date.now());
        await worker(store, { clock: clock.now }).visit("w_a");
        const backoff = Number(await probe.zscore(due, "w_a"));

        await expect(
          store.complete({
            waitpointId: "w_a",
            completion: completion({ output: { inline: '{"different":true}' } }),
          })
        ).rejects.toThrow(WaitpointCompletionConflictError);

        expect(Number(await probe.zscore(due, "w_a"))).toBe(backoff);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest("a first completion with watchers is promptly due", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await pending(store, "w_a");
      await blockRuns(store, "w_a", ["run_1"]);

      // The flip schedules the new fanout unconditionally, because it just created the
      // work and knows no schedule exists to trample.
      const due = fanoutIndexKeys(fanoutPartition("w_a")).due;
      const before = Date.now();
      await store.complete({ waitpointId: "w_a", completion: completion() });

      const scheduled = Number(await probe.zscore(due, "w_a"));
      expect(scheduled).toBeGreaterThanOrEqual(before);
      expect((await worker(store).runOnce(scheduled)).visits[0]).toMatchObject({
        delivered: 1,
        outcome: "drained",
      });
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("the pre-flip hint is still filed when absent", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await pending(store, "w_a");
      await blockRuns(store, "w_a", ["run_1"]);
      const due = fanoutIndexKeys(fanoutPartition("w_a")).due;
      expect(await probe.zscore(due, "w_a")).toBeNull();

      await store.complete({ waitpointId: "w_a", completion: completion() });
      expect(await probe.zscore(due, "w_a")).not.toBeNull();
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest(
    "a missing record LEAVES its hint, and the worker retires it",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      const due = fanoutIndexKeys(fanoutPartition("w_ghost")).due;
      try {
        await expect(
          store.complete({ waitpointId: "w_ghost", completion: completion() })
        ).rejects.toThrow(WaitpointNotFoundError);

        // Deliberately still discoverable. Dropping it here was a cross-slot
        // check-then-delete that could take a concurrent create-and-complete's hint with it.
        expect(await probe.zscore(due, "w_ghost")).not.toBeNull();

        // The worker is what retires it, on the record still being absent.
        const tick = await worker(store).runOnce();
        expect(tick.visits[0]).toMatchObject({ waitpointId: "w_ghost", outcome: "absent" });
        expect(await probe.zscore(due, "w_ghost")).toBeNull();
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  // End-to-end characterization, NOT a revert guard: the sequence here is not interleaved, so
  // it stays green even with the drop restored. "a missing record LEAVES its hint" is the
  // guard — the race is closed by there being no cross-slot delete at all.
  redisTest(
    "a create-and-complete after a missing completion still fans out",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      const due = fanoutIndexKeys(fanoutPartition("w_race")).due;
      try {
        // The failing completion runs first against a record that does not exist yet.
        await expect(
          store.complete({ waitpointId: "w_race", completion: completion() })
        ).rejects.toThrow(WaitpointNotFoundError);

        // Then the waitpoint is genuinely created, blocked on and completed. Under the old
        // ordering the first call's hint drop could land here and strand this fanout.
        await pending(store, "w_race");
        await blockRuns(store, "w_race", ["run_race"]);
        await store.complete({ waitpointId: "w_race", completion: completion() });

        expect(await probe.zscore(due, "w_race")).not.toBeNull();
        const tick = await worker(store).runOnce();
        expect(tick.visits[0]).toMatchObject({ delivered: 1, outcome: "drained" });
        expect(await receiptFor(probe, "run_race", "w_race")).not.toBeNull();
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );
});

describe("option validation at construction", () => {
  redisTest("an unusable option fails fast and names itself", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      expect(() => new WaitpointFanoutWorker({ coordinator: store, pageSize: 0 })).toThrow(
        /pageSize must be a positive safe integer/
      );
      expect(() => new WaitpointFanoutWorker({ coordinator: store, dueBatchSize: 0 })).toThrow(
        /dueBatchSize must be a positive safe integer/
      );
      expect(
        () =>
          new WaitpointFanoutWorker({
            coordinator: store,
            retryPolicy: { baseDelayMs: 5_000, maxDelayMs: 1_000 },
          })
      ).toThrow(/maxDelayMs .* must be >= baseDelayMs/);
      // Defaults are unchanged and still construct.
      expect(() => new WaitpointFanoutWorker({ coordinator: store })).not.toThrow();
    } finally {
      await store.quit();
    }
  });
});

describe("worker restart", () => {
  redisTest("a worker stopped and started again sweeps on its timer", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await pending(store, "w_a");
      await blockRuns(store, "w_a", ["run_1"]);
      await store.complete({ waitpointId: "w_a", completion: completion() });

      // A barrier, not a sleep: it settles the instant a SCHEDULED tick claims a page, and
      // the bound below only decides how fast a broken restart fails. Driving runOnce()
      // directly would prove nothing here — the tick is the thing that reads the flag a
      // stop() used to latch.
      let claimed: () => void = () => undefined;
      const swept = new Promise<void>((resolve) => {
        claimed = resolve;
      });

      const restarted = new WaitpointFanoutWorker({
        coordinator: store,
        enabled: true,
        workerId: "worker-restart",
        leaseMs: LEASE_MS,
        pollIntervalMs: 20,
        hooks: { onPageClaimed: async () => claimed() },
      });

      restarted.start();
      await restarted.stop();
      restarted.start();

      await Promise.race([
        swept,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("no scheduled sweep after restart")), 5_000)
        ),
      ]);
      await restarted.stop();

      expect(await receiptFor(probe, "run_1", "w_a")).not.toBeNull();
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("start and stop are idempotent and leave no extra timer", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const idle = worker(store);
      idle.start();
      idle.start();
      await idle.stop();
      await idle.stop();
      idle.start();
      await idle.stop();
      // Reaching here without a hang or a stray interval is the assertion; a duplicated
      // timer would keep the process's event loop referenced past the test.
      expect(idle.enabled).toBe(true);
    } finally {
      await store.quit();
    }
  });
});

describe("authoritative retry backoff", () => {
  async function stalled(store: WaitpointStoreCoordinator, probe: Redis, id = "w_a") {
    await pending(store, id);
    await blockRuns(store, id, ["run_1"]);
    await store.complete({ waitpointId: id, completion: completion() });
    await probe.hset(
      waitpointKeys(id).watchers,
      blockedWatcherField("run_1"),
      JSON.stringify({ runId: "", blockId: BLOCK, createdAt: NOW })
    );
  }

  function failing(
    store: WaitpointStoreCoordinator,
    workerId: string,
    clock: () => number,
    maxFailures = 5
  ) {
    return new WaitpointFanoutWorker({
      clock,
      coordinator: store,
      enabled: true,
      workerId,
      leaseMs: LEASE_MS,
      retryPolicy: { baseDelayMs: 10_000, maxDelayMs: 40_000, maxFailures },
    });
  }

  redisTest(
    "an immediate concurrent re-claim is refused, not retried without backoff",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const clock = fakeClock();
      const probe = createRedisClient(redisOptions);
      try {
        await stalled(store, probe);
        const fanout = waitpointKeys("w_a").fanout;
        const now = Date.now();

        clock.set(now);

        expect(await failing(store, "worker-a", clock.now).visit("w_a")).toMatchObject({
          outcome: "released",
        });
        expect(Number(await probe.hget(fanout, "nb"))).toBe(now + 10_000);

        // A second worker sweeping at once — the exact window the index alone could not
        // close, because between the release and the index write the old score is still due.
        clock.set(now + 1);
        const second = await failing(store, "worker-b", clock.now).visit("w_a");
        expect(second).toMatchObject({ outcome: "notdue", notBefore: now + 10_000 });

        // No claim, so no attempt, no second failure and no drift towards quarantine.
        expect(await probe.hget(fanout, "fail")).toBe("1");
        expect(await probe.hget(fanout, "att")).toBe("1");
        expect(await probe.hget(fanout, "state")).toBe("pending");
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "a crash before the index repair costs a probe, never an early claim",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const clock = fakeClock();
      const probe = createRedisClient(redisOptions);
      try {
        await stalled(store, probe);
        const fanout = waitpointKeys("w_a").fanout;
        const due = fanoutIndexKeys(fanoutPartition("w_a")).due;
        const now = Date.now();

        // The failure lands on the entry; the index repair never happens.
        const epoch = await claimEpoch(store, "w_a", "worker-crash", now);
        const released = await store.releaseFanout({
          waitpointId: "w_a",
          workerId: "worker-crash",
          epoch,
          action: "fail",
          maxFailures: 5,
          retryPolicy: { baseDelayMs: 10_000, maxDelayMs: 40_000 },
          now,
        });
        expect(released).toMatchObject({ outcome: "released", notBefore: now + 10_000 });

        // The index still says due, so a sweep finds it — that is the allowed early probe.
        expect(Number(await probe.zscore(due, "w_a"))).toBeLessThanOrEqual(now);
        clock.set(now + 1);
        const probed = await failing(store, "worker-b", clock.now).visit("w_a");
        expect(probed).toMatchObject({ outcome: "notdue" });
        expect(await probe.hget(fanout, "fail")).toBe("1");

        // And the probe repairs the index, so the next sweep is not early either.
        expect(Number(await probe.zscore(due, "w_a"))).toBe(now + 10_000);
        expect(
          await store.dueFanoutEntries({
            partition: fanoutPartition("w_a"),
            limit: 10,
            now: now + 2,
          })
        ).toEqual([]);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest("the backoff progresses, then resets on progress", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const clock = fakeClock();
    const probe = createRedisClient(redisOptions);
    try {
      await stalled(store, probe);
      const fanout = waitpointKeys("w_a").fanout;
      const policy = { baseDelayMs: 10_000, maxDelayMs: 40_000, maxFailures: 9 };
      const worker9 = new WaitpointFanoutWorker({
        clock: clock.now,
        coordinator: store,
        enabled: true,
        workerId: "worker-a",
        leaseMs: LEASE_MS,
        retryPolicy: policy,
      });

      // Pinned against fanoutRetryDelayMs, which stays the definition of this curve; the
      // Lua mirrors it and this is what keeps the two in step.
      let at = Date.now();
      for (const attempt of [1, 2, 3]) {
        clock.set(at);
        await worker9.visit("w_a");
        expect(Number(await probe.hget(fanout, "fail"))).toBe(attempt);
        expect(Number(await probe.hget(fanout, "nb"))).toBe(
          at + fanoutRetryDelayMs(attempt, policy)
        );
        at += 60_000;
      }
      expect(Number(await probe.hget(fanout, "nb"))).toBeGreaterThan(0);

      // Repair the watcher; a page that makes progress clears both the streak and the delay.
      await probe.hset(
        waitpointKeys("w_a").watchers,
        blockedWatcherField("run_1"),
        JSON.stringify({ runId: "run_1", blockId: `${BLOCK}_run_1`, createdAt: NOW })
      );
      await store.absorbBlockers({
        runId: "run_1",
        blockId: `${BLOCK}_run_1`,
        edges: [edge("w_a")],
      });
      clock.set(at);
      expect(await worker9.visit("w_a")).toMatchObject({ delivered: 1, outcome: "drained" });
      expect(await probe.hget(fanout, "fail")).toBe("0");
      expect(Number(await probe.hget(fanout, "nb"))).toBe(at);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("the entry is claimable again at exactly the due time", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const clock = fakeClock();
    const probe = createRedisClient(redisOptions);
    try {
      await stalled(store, probe);
      const now = Date.now();
      clock.set(now);
      await failing(store, "worker-a", clock.now).visit("w_a");
      const notBefore = Number(await probe.hget(waitpointKeys("w_a").fanout, "nb"));

      // One millisecond early: refused. At the due time: claimable.
      expect(
        await store.claimFanoutPage({
          waitpointId: "w_a",
          workerId: "worker-b",
          pageSize: 10,
          leaseMs: LEASE_MS,
          now: notBefore - 1,
        })
      ).toMatchObject({ outcome: "notdue", notBefore });
      expect(
        await store.claimFanoutPage({
          waitpointId: "w_a",
          workerId: "worker-b",
          pageSize: 10,
          leaseMs: LEASE_MS,
          now: notBefore,
        })
      ).toMatchObject({ outcome: "claimed" });
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("a quarantined entry stays refused on its own terms", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const clock = fakeClock();
    const probe = createRedisClient(redisOptions);
    try {
      await stalled(store, probe);
      const quarantining = failing(store, "worker-a", clock.now, 2);
      let at = Date.now();
      clock.set(at);
      expect(await quarantining.visit("w_a")).toMatchObject({ outcome: "released" });
      at += 60_000;
      clock.set(at);
      expect(await quarantining.visit("w_a")).toMatchObject({ outcome: "quarantined" });

      // Quarantine wins over the due time: even well past notBefore it is not claimable.
      expect(
        await store.claimFanoutPage({
          waitpointId: "w_a",
          workerId: "worker-b",
          pageSize: 10,
          leaseMs: LEASE_MS,
          now: at + 1_000_000,
        })
      ).toMatchObject({ outcome: "quarantined" });
      expect(await probe.pttl(waitpointKeys("w_a").fanout)).toBe(-1);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });
});

describe("terminal disposal", () => {
  redisTest(
    "dispose unregisters the metrics callback, so no collection reaches Redis",
    async ({ redisOptions }) => {
      const { meter, getCounterValue } = createTestMetricsMeter();
      const store = new WaitpointStoreCoordinator({
        redisOptions,
        terminalRetentionMs: RETENTION_MS,
      });
      // Count the reads the batch callback makes, which is the thing that must stop.
      let backlogReads = 0;
      const realBacklog = store.fanoutBacklog.bind(store);
      store.fanoutBacklog = async () => {
        backlogReads++;
        return realBacklog();
      };

      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });

        const observed = new WaitpointFanoutWorker({
          coordinator: store,
          enabled: true,
          workerId: "worker-metrics",
          leaseMs: LEASE_MS,
          meter,
        });

        // A collection while the worker is live reads the backlog.
        expect(await getCounterValue("waitpoint.fanout.backlog")).toBe(1);
        expect(backlogReads).toBeGreaterThan(0);
        const readsWhileLive = backlogReads;

        await observed.dispose();

        // After disposal the callback is gone, so a further collection reads nothing —
        // which is what keeps it off a coordinator the caller is about to close.
        await getCounterValue("waitpoint.fanout.backlog");
        await getCounterValue("waitpoint.fanout.quarantine_depth");
        expect(backlogReads).toBe(readsWhileLive);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("dispose is idempotent", async ({ redisOptions }) => {
    const { meter } = createTestMetricsMeter();
    const store = coordinator(redisOptions);
    try {
      const disposable = new WaitpointFanoutWorker({
        coordinator: store,
        enabled: true,
        workerId: "worker-dispose",
        leaseMs: LEASE_MS,
        meter,
      });

      await disposable.dispose();
      await disposable.dispose();
      await disposable.dispose();
      // A second removal of an already-removed callback would throw inside the meter.
      expect(true).toBe(true);
    } finally {
      await store.quit();
    }
  });

  redisTest("restart before disposal still works", async ({ redisOptions }) => {
    const { meter } = createTestMetricsMeter();
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await pending(store, "w_a");
      await blockRuns(store, "w_a", ["run_1"]);
      await store.complete({ waitpointId: "w_a", completion: completion() });

      const restartable = new WaitpointFanoutWorker({
        coordinator: store,
        enabled: true,
        workerId: "worker-restart-dispose",
        leaseMs: LEASE_MS,
        meter,
      });

      // stop() stays restartable; only dispose() is terminal.
      restartable.start();
      await restartable.stop();
      restartable.start();
      await restartable.stop();
      expect((await restartable.runOnce()).visits[0]).toMatchObject({
        delivered: 1,
        outcome: "drained",
      });
      expect(await receiptFor(probe, "run_1", "w_a")).not.toBeNull();

      await restartable.dispose();
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("a disposed worker refuses to do any work", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await pending(store, "w_a");
      await blockRuns(store, "w_a", ["run_1"]);
      await store.complete({ waitpointId: "w_a", completion: completion() });

      const disposed = worker(store, { workerId: "worker-gone" });
      await disposed.dispose();

      expect(() => disposed.start()).toThrow(/start\(\) called after dispose\(\)/);
      await expect(disposed.runOnce()).rejects.toThrow(/runOnce\(\) called after dispose\(\)/);
      await expect(disposed.visit("w_a")).rejects.toThrow(/visit\(\) called after dispose\(\)/);
    } finally {
      await store.quit();
    }
  });
});

describe("fenced due-index rescheduling", () => {
  // Every case below is a real two-worker ordering, driven by an explicit barrier: the
  // slow worker is suspended INSIDE its visit at the point where it has decided what to
  // reschedule but has not yet written the cross-slot index, the fast worker then does
  // something that changes the schedule, and only then is the slow worker released.
  async function unroutable(
    probe: Redis,
    waitpointId: string,
    field = blockedWatcherField("run_1")
  ) {
    await probe.hset(
      waitpointKeys(waitpointId).watchers,
      field,
      JSON.stringify({ runId: "", blockId: BLOCK, createdAt: NOW })
    );
  }

  // The two cases below reach the fence through the coordinator rather than through a
  // suspended worker. A worker held at its ack loses the claim to whoever reclaims it and
  // returns `lost` before its reschedule ever runs — so a barrier there would exercise the
  // reclaim, not the fence. These drive the exact call the yield and failure paths make,
  // after another worker has changed the schedule underneath them.
  redisTest(
    "a stale reschedule cannot undo a backoff installed after it decided",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const clock = fakeClock();
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });
        await unroutable(probe, "w_a");
        const due = fanoutIndexKeys(fanoutPartition("w_a")).due;
        const now = Date.now();

        // The newer owner fails and installs a backoff.
        const fast = new WaitpointFanoutWorker({
          clock: clock.now,
          coordinator: store,
          enabled: true,
          workerId: "worker-fast",
          leaseMs: LEASE_MS,
          retryPolicy: { baseDelayMs: 90_000, maxDelayMs: 120_000, maxFailures: 5 },
        });
        clock.set(now);
        await fast.visit("w_a");
        const backoff = Number(await probe.zscore(due, "w_a"));
        expect(backoff).toBeGreaterThanOrEqual(now + 90_000);

        // The overtaken worker's yield wanted prompt continuation, and its failure path
        // would have wanted a shorter backoff. Neither may lower what is there.
        await store.rescheduleFanoutVisit("w_a", now);
        expect(Number(await probe.zscore(due, "w_a"))).toBe(backoff);
        await store.rescheduleFanoutVisit("w_a", now + 1_000);
        expect(Number(await probe.zscore(due, "w_a"))).toBe(backoff);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "a stale reschedule cannot resurrect an entry another worker drained",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });
        const due = fanoutIndexKeys(fanoutPartition("w_a")).due;

        // The fast worker finishes the fanout and retires the hint.
        expect(await worker(store, { workerId: "worker-fast" }).visit("w_a")).toMatchObject({
          outcome: "drained",
        });
        expect(await probe.zscore(due, "w_a")).toBeNull();

        // Every reschedule an overtaken worker could make must leave it retired.
        await store.rescheduleFanoutVisit("w_a", Date.now());
        await store.rescheduleFanoutVisit("w_a", Date.now() + 60_000);
        expect(await probe.zscore(due, "w_a")).toBeNull();
        expect((await worker(store).runOnce(Date.now() + 120_000)).visits).toEqual([]);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "a stale busy reschedule cannot pull a newer backoff earlier",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const clock = fakeClock();
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });
        await unroutable(probe, "w_a");
        const due = fanoutIndexKeys(fanoutPartition("w_a")).due;
        const now = Date.now();

        // A live claim, so the next worker sees `busy` and wants to defer to lease expiry.
        await claimEpoch(store, "w_a", "worker-holder", now);

        const observer = worker(store, { clock: clock.now, workerId: "worker-observer" });
        clock.set(now + 1);
        expect(await observer.visit("w_a")).toMatchObject({ outcome: "busy" });
        expect(Number(await probe.zscore(due, "w_a"))).toBe(now + LEASE_MS);

        // The holder now fails with a backoff BEYOND its own lease expiry.
        const holder = new WaitpointFanoutWorker({
          clock: clock.now,
          coordinator: store,
          enabled: true,
          workerId: "worker-holder",
          leaseMs: LEASE_MS,
          retryPolicy: { baseDelayMs: 120_000, maxDelayMs: 120_000, maxFailures: 5 },
        });
        clock.set(now + 2);
        await holder.visit("w_a");
        const backoff = Number(await probe.zscore(due, "w_a"));
        expect(backoff).toBeGreaterThan(now + LEASE_MS);

        // A second observer, still seeing a live claim, must not drag it back.
        clock.set(now + 3);
        await observer.visit("w_a");
        expect(Number(await probe.zscore(due, "w_a"))).toBe(backoff);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest("a clean yield continues promptly", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const clock = fakeClock();
    const probe = createRedisClient(redisOptions);
    try {
      const runIds = Array.from({ length: 4 }, (_, i) => `run_${i}`);
      await pending(store, "w_a");
      await blockRuns(store, "w_a", runIds);
      await store.complete({ waitpointId: "w_a", completion: completion() });
      const due = fanoutIndexKeys(fanoutPartition("w_a")).due;

      const paged = worker(store, { clock: clock.now, pageSize: 2, maxPagesPerVisit: 1 });
      const now = Date.now();
      clock.set(now);
      expect(await paged.visit("w_a")).toMatchObject({ delivered: 2, outcome: "more" });

      // Still due, so the very next sweep picks it up rather than waiting anything out.
      expect(Number(await probe.zscore(due, "w_a"))).toBeLessThanOrEqual(now);
      clock.set(now);
      expect(await paged.visit("w_a")).toMatchObject({ delivered: 2, outcome: "drained" });
      for (const runId of runIds) {
        expect(await receiptFor(probe, runId, "w_a")).not.toBeNull();
      }
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("a failure backoff is preserved against a later yield", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const clock = fakeClock();
    const probe = createRedisClient(redisOptions);
    try {
      await pending(store, "w_a");
      await blockRuns(store, "w_a", ["run_1"]);
      await store.complete({ waitpointId: "w_a", completion: completion() });
      await unroutable(probe, "w_a");
      const due = fanoutIndexKeys(fanoutPartition("w_a")).due;

      const failing = new WaitpointFanoutWorker({
        clock: clock.now,
        coordinator: store,
        enabled: true,
        workerId: "worker-a",
        leaseMs: LEASE_MS,
        retryPolicy: { baseDelayMs: 45_000, maxDelayMs: 60_000, maxFailures: 5 },
      });
      const now = Date.now();
      clock.set(now);
      await failing.visit("w_a");
      const backoff = Number(await probe.zscore(due, "w_a"));
      expect(backoff).toBeGreaterThanOrEqual(now + 45_000);

      // A sweep before the backoff expires finds nothing, and nothing has moved it.
      expect(
        await store.dueFanoutEntries({ partition: fanoutPartition("w_a"), limit: 10, now })
      ).toEqual([]);
      expect(Number(await probe.zscore(due, "w_a"))).toBe(backoff);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest(
    "discoverability survives a crash: the entry stays in the index",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const clock = fakeClock();
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });
        const due = fanoutIndexKeys(fanoutPartition("w_a")).due;

        const crashing = worker(store, {
          clock: clock.now,
          workerId: "worker-crash",
          hooks: {
            onPageClaimed: async () => {
              throw new Error("killed mid-visit");
            },
          },
        });
        clock.set(Date.now());
        await expect(crashing.visit("w_a")).rejects.toThrow("killed mid-visit");

        // Nothing rescheduled or retired it, so it is still discoverable and a survivor
        // finishes the work once the lease lapses.
        expect(await probe.zscore(due, "w_a")).not.toBeNull();
        clock.set(Date.now() + LEASE_MS + 1);
        expect(
          await worker(store, { clock: clock.now, workerId: "worker-b" }).visit("w_a")
        ).toMatchObject({ delivered: 1, outcome: "drained" });
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );
});

describe("due-batch fairness", () => {
  redisTest(
    "a full page of busy entries does not hide a runnable one behind it",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      const PARTITION = 0;
      const BATCH = 3;
      try {
        // BATCH + 1 waitpoints in ONE partition, so they compete inside a single bounded
        // due query.
        const ids = idsInPartition(PARTITION, BATCH + 1, "w_fair_");
        const busyIds = ids.slice(0, BATCH);
        const runnableId = ids[BATCH]!;

        for (const id of ids) {
          await pending(store, id);
          await blockRuns(store, id, [`run_${id}`]);
          await store.complete({ waitpointId: id, completion: completion() });
        }

        // The busy entries sort ahead of the runnable one, and each is held under a live
        // claim by a worker that is not ours.
        const base = Date.now();
        for (const [i, id] of busyIds.entries()) {
          await store.scheduleFanoutVisit(id, base + i);
          await store.claimFanoutPage({
            waitpointId: id,
            workerId: `foreign-${i}`,
            pageSize: 10,
            leaseMs: LEASE_MS,
            now: base,
          });
        }
        await store.scheduleFanoutVisit(runnableId, base + 100);

        const fanoutWorker = worker(store, { dueBatchSize: BATCH });

        // Tick one sees only the busy head page and can deliver nothing.
        const first = await fanoutWorker.runOnce(base + 200);
        expect(first.visits.map((v) => v.waitpointId).sort()).toEqual([...busyIds].sort());
        expect(first.visits.every((v) => v.outcome === "busy")).toBe(true);

        // Tick two must reach the runnable entry. Without rescoring the busy ones they
        // would still be at the head of the query and this would starve indefinitely.
        const second = await fanoutWorker.runOnce(base + 300);
        expect(second.visits.map((v) => v.waitpointId)).toEqual([runnableId]);
        expect(second.visits[0]).toMatchObject({ delivered: 1, outcome: "drained" });
        expect(await receiptFor(probe, `run_${runnableId}`, runnableId)).not.toBeNull();

        // The deferred entries come back exactly when their claims lapse.
        for (const id of busyIds) {
          expect(Number(await probe.zscore(fanoutIndexKeys(PARTITION).due, id))).toBe(
            base + LEASE_MS
          );
        }
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );
});

/**
 * Why every operation inside a visit samples the clock rather than inheriting one instant.
 *
 * A wide fan-out drains over several pages and can outlive the moment it started. With one
 * captured timestamp for the whole visit, each page's claim renewed the lease to
 * `started + leaseMs` no matter how long the drain had actually been running, so a lease
 * the worker believed it held had already lapsed in real time and another worker could
 * steal the page mid-visit.
 */
describe("lease renewal across pages", () => {
  redisTest(
    "a page claimed after the original lease lapsed gets a fresh lease of its own",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const clock = fakeClock();
      const probe = createRedisClient(redisOptions);
      try {
        const PAGE = 5;
        const runIds = Array.from({ length: 2 * PAGE }, (_, i) => `run_${i}`);
        await pending(store, "w_a");
        await blockRuns(store, "w_a", runIds);
        await store.complete({ waitpointId: "w_a", completion: completion() });

        const base = Date.now();
        clock.set(base);

        const fanout = waitpointKeys("w_a").fanout;
        let acks = 0;
        const observed: Array<{ lease: number; foreign: string }> = [];

        const draining = worker(store, {
          clock: clock.now,
          workerId: "worker-a",
          pageSize: PAGE,
          hooks: {
            beforeAck: async () => {
              acks++;
              if (acks === 1) {
                // Page one took longer than the whole lease. Nothing here is a sleep: the
                // injected clock is simply moved past it.
                clock.advance(LEASE_MS + 1);
                return;
              }
              // Page two, mid-flight. A second worker sweeping right now must be refused:
              // the lease it would test against has to be page TWO's, not page one's.
              const foreign = await store.claimFanoutPage({
                waitpointId: "w_a",
                workerId: "worker-b",
                pageSize: PAGE,
                leaseMs: LEASE_MS,
                now: clock.now(),
              });
              observed.push({
                lease: Number(await probe.hget(fanout, "lease")),
                foreign: foreign.outcome,
              });
            },
          },
        });

        const summary = await draining.visit("w_a");

        // The drain completed under its own claims — page two was never lost.
        expect(summary).toMatchObject({ pages: 2, delivered: 2 * PAGE, outcome: "drained" });
        expect(observed).toHaveLength(1);
        // A fresh lease, taken from the advanced clock rather than the visit's start.
        expect(observed[0]!.lease).toBe(base + LEASE_MS + 1 + LEASE_MS);
        // And so the concurrent sweep finds a live claim instead of an expired one.
        expect(observed[0]!.foreign).toBe("busy");

        for (const runId of runIds) {
          expect(await receiptFor(probe, runId, "w_a")).not.toBeNull();
        }
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );
});

/**
 * The starvation the bounded `pending-record` deferral exists to prevent.
 *
 * A completion files its hint BEFORE it flips the record, so a hint on a still-pending
 * record is legitimate and must never be deleted — the entry the flip is about to create
 * would be stranded. But a completion that filed a hint and then died leaves one for good,
 * and a hint that keeps its score sits at the head of every bounded due query forever.
 */
describe("abandoned pre-flip hints", () => {
  redisTest(
    "a full page of abandoned hints does not hide a completed waitpoint behind it",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      const PARTITION = 0;
      const BATCH = 3;
      try {
        // BATCH + 1 waitpoints in ONE partition, so they compete inside a single bounded
        // due query.
        const ids = idsInPartition(PARTITION, BATCH + 1, "w_hint_");
        const abandonedIds = ids.slice(0, BATCH);
        const completedId = ids[BATCH]!;
        const base = Date.now();
        const clock = fakeClock(base);

        // A full batch of hints whose completions never flipped the record, sorting ahead
        // of the one waitpoint that is genuinely ready.
        for (const [i, id] of abandonedIds.entries()) {
          await pending(store, id);
          await blockRuns(store, id, [`run_${id}`]);
          await store.scheduleFanoutVisit(id, base + i);
        }
        await pending(store, completedId);
        await blockRuns(store, completedId, [`run_${completedId}`]);
        await store.complete({ waitpointId: completedId, completion: completion() });
        await store.rescheduleFanoutVisit(completedId, base + 100);

        const fanoutWorker = worker(store, {
          clock: clock.now,
          dueBatchSize: BATCH,
          hintGraceMs: GRACE_MS,
        });

        // Tick one sees only the abandoned head page and can deliver nothing.
        clock.set(base + 200);
        const first = await fanoutWorker.runOnce();
        expect(first.visits.map((v) => v.waitpointId).sort()).toEqual([...abandonedIds].sort());
        expect(first.visits.every((v) => v.outcome === "pending-record")).toBe(true);
        // Deferred, never deleted: every one is still discoverable, just later.
        for (const id of abandonedIds) {
          expect(Number(await probe.zscore(fanoutIndexKeys(PARTITION).due, id))).toBe(
            base + 200 + GRACE_MS
          );
        }

        // Tick two must reach the completed waitpoint. Leaving the abandoned scores alone
        // would keep them at the head of this query and starve it indefinitely.
        clock.set(base + 300);
        const second = await fanoutWorker.runOnce();
        expect(second.visits.map((v) => v.waitpointId)).toEqual([completedId]);
        expect(second.visits[0]).toMatchObject({ delivered: 1, outcome: "drained" });
        expect(await receiptFor(probe, `run_${completedId}`, completedId)).not.toBeNull();
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "a deferral that lands after the flip costs the grace once and never loses the entry",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        const due = fanoutIndexKeys(fanoutPartition("w_a")).due;
        const base = Date.now();
        await store.scheduleFanoutVisit("w_a", base);

        // The worker's own sequence, interleaved by hand: the claim returns the pre-flip
        // verdict, the flip lands, and only THEN does the worker write its deferral. No
        // hook fires on this branch, so the ordering is scripted through the same exported
        // operations `visit` calls, in the same order.
        const claim = await store.claimFanoutPage({
          waitpointId: "w_a",
          workerId: "worker-a",
          pageSize: 10,
          leaseMs: LEASE_MS,
          now: base,
        });
        expect(claim.outcome).toBe("pending-record");

        await store.complete({ waitpointId: "w_a", completion: completion() });
        const flippedTo = Number(await probe.zscore(due, "w_a"));

        await store.rescheduleFanoutVisit("w_a", base + GRACE_MS);

        // Bounded and update-only: the deferral can push the brand-new fanout out by at
        // most the grace, and cannot remove it or push it past that.
        const deferredTo = Number(await probe.zscore(due, "w_a"));
        expect(deferredTo).toBeGreaterThanOrEqual(flippedTo);
        expect(deferredTo).toBeLessThanOrEqual(base + GRACE_MS);

        // And the fanout still drains, on its own, once the grace has passed.
        expect(await worker(store).runOnce(base + GRACE_MS)).toMatchObject({
          visits: [{ waitpointId: "w_a", delivered: 1, outcome: "drained" }],
        });
        expect(await receiptFor(probe, "run_1", "w_a")).not.toBeNull();
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );
});

/**
 * The lost wake-up the block-scoped watcher field exists to prevent.
 *
 * A run blocks on a waitpoint, fails to resume, and blocks on the SAME waitpoint again
 * under a new block operation. Keyed on the run alone the second registration collided with
 * the first under HSETNX: the stored watcher still named the OLD block, so completion
 * delivered under an obsolete block id, the run's shard refused it as stale, and the block
 * the run was actually sitting on never heard.
 */
describe("block-scoped watcher registration", () => {
  const RUN = "run_cycles";
  const BLOCK_1 = "blk_cycle_1";
  const BLOCK_2 = "blk_cycle_2";

  redisTest("block one registers a watcher on a pending waitpoint", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await pending(store, "w_a");
      await store.registerBlocks({ runId: RUN, blockId: BLOCK_1, edges: [edge("w_a")] });

      const watchers = await probe.hgetall(waitpointKeys("w_a").watchers);
      expect(Object.keys(watchers)).toEqual([watcherField(RUN, BLOCK_1)]);
      expect(JSON.parse(watchers[watcherField(RUN, BLOCK_1)]!)).toMatchObject({
        runId: RUN,
        blockId: BLOCK_1,
      });
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest(
    "a second block on the same waitpoint gets its own watcher, not the first one's",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await store.registerBlocks({ runId: RUN, blockId: BLOCK_1, edges: [edge("w_a")] });
        // The run never resumed, so it rolls over onto a fresh block operation and blocks
        // on the very same waitpoint again.
        await store.registerBlocks({
          runId: RUN,
          blockId: BLOCK_2,
          edges: [edge("w_a")],
          expectedPreviousBlockId: BLOCK_1,
        });

        // Block 2's registration is present and is its OWN. Run-keyed, HSETNX would have kept
        // block 1's entry and the CURRENT block would have had no watcher at all — and the
        // rollover cleanup would then have withdrawn the only registration there was, so the
        // two fixes are complementary rather than alternatives.
        const watchers = await probe.hgetall(waitpointKeys("w_a").watchers);
        expect(Object.keys(watchers)).toEqual([watcherField(RUN, BLOCK_2)]);
        expect(JSON.parse(watchers[watcherField(RUN, BLOCK_2)]!)).toMatchObject({
          blockId: BLOCK_2,
        });
        // And block 1's is gone, withdrawn by the rollover rather than left on the shard.
        expect(watchers[watcherField(RUN, BLOCK_1)]).toBeUndefined();
        expect((await store.readBlockState(RUN)).blockId).toBe(BLOCK_2);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "completion rejects the obsolete registration, delivers to block two, and block two resumes",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await store.registerBlocks({ runId: RUN, blockId: BLOCK_1, edges: [edge("w_a")] });
        await store.registerBlocks({
          runId: RUN,
          blockId: BLOCK_2,
          edges: [edge("w_a")],
          expectedPreviousBlockId: BLOCK_1,
        });

        await store.complete({ waitpointId: "w_a", completion: completion() });
        const visit = await worker(store).visit("w_a");

        // Block 1's registration was withdrawn at rollover, so there is nothing obsolete left
        // to deliver to and refuse: one delivery, none rejected. The queue still holds block
        // 1's entry — the queue is append-only — but its watcher is gone, so it retires as a
        // stale watcher instead of costing a run-shard round trip.
        expect(visit).toMatchObject({ delivered: 1, rejected: 0, outcome: "drained" });
        expect(visit.staleWatchers).toBe(1);
        expect(await receiptFor(probe, RUN, "w_a")).not.toBeNull();

        const state = await store.readBlockState(RUN);
        expect(state.blockId).toBe(BLOCK_2);
        expect(state.pendingIds).toEqual([]);
        expect(state.deliveredIds).toEqual(["w_a"]);
        // Resumable, which is the whole point: the wake-up reached the block the run is on.
        expect(state.handoff).toBe("owed");
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest("a delayed block-one retry cannot displace block two", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await pending(store, "w_a");
      await store.registerBlocks({ runId: RUN, blockId: BLOCK_1, edges: [edge("w_a")] });
      await store.registerBlocks({
        runId: RUN,
        blockId: BLOCK_2,
        edges: [edge("w_a")],
        expectedPreviousBlockId: BLOCK_1,
      });
      await store.complete({ waitpointId: "w_a", completion: completion() });
      await worker(store).visit("w_a");
      expect((await store.readBlockState(RUN)).handoff).toBe("owed");

      // A redelivery of the OBSOLETE registration, arriving after block two settled —
      // an at-least-once retry of the watcher the first block left behind.
      const late = await store.deliverCompletion({
        runId: RUN,
        blockId: BLOCK_1,
        waitpointId: "w_a",
        completion: completion({ output: { inline: '{"stale":true}' } }),
      });

      // Refused, and told which block the run is actually on. It neither overwrote the
      // receipt nor re-armed a handoff block two already owns.
      expect(late).toMatchObject({ outcome: "stale", currentBlockId: BLOCK_2 });
      expect(JSON.parse((await receiptFor(probe, RUN, "w_a"))!)).toEqual(completion());
      const state = await store.readBlockState(RUN);
      expect(state.blockId).toBe(BLOCK_2);
      expect(state.deliveredIds).toEqual(["w_a"]);
      expect(state.handoff).toBe("owed");
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest(
    "repeated registrations of the SAME block leave one effective watcher",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        // A retry of one block operation, not a rollover: the block id is the identity, so
        // three attempts are one registration and must not fan out three times.
        for (let attempt = 0; attempt < 3; attempt++) {
          await store.registerBlocks({ runId: RUN, blockId: BLOCK_1, edges: [edge("w_a")] });
        }

        expect(await probe.hlen(waitpointKeys("w_a").watchers)).toBe(1);
        await store.complete({ waitpointId: "w_a", completion: completion() });
        expect(await worker(store).visit("w_a")).toMatchObject({
          delivered: 1,
          duplicates: 0,
          rejected: 0,
          outcome: "drained",
        });
        expect(await probe.hlen(`wp:v1:run:{${RUN}}:done`)).toBe(1);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );
});

describe("watcher unregistration", () => {
  redisTest(
    "a watcher cancelled before completion is never delivered to",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_keep", "run_cancel"]);

        const removed = await store.unregisterWatcher({
          waitpointId: "w_a",
          runId: "run_cancel",
          blockId: `${BLOCK}_run_cancel`,
        });
        expect(removed.outcome).toBe("unregistered");

        await store.complete({ waitpointId: "w_a", completion: completion() });
        const tick = await worker(store).runOnce();

        expect(tick.visits[0]).toMatchObject({
          delivered: 1,
          staleWatchers: 1,
          outcome: "drained",
        });
        expect(await receiptFor(probe, "run_keep", "w_a")).not.toBeNull();
        expect(await receiptFor(probe, "run_cancel", "w_a")).toBeNull();
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "unregistration is idempotent and tolerates a vanished record",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);

        const blockId = `${BLOCK}_run_1`;
        expect(
          (await store.unregisterWatcher({ waitpointId: "w_a", runId: "run_1", blockId })).outcome
        ).toBe("unregistered");
        expect(
          (await store.unregisterWatcher({ waitpointId: "w_a", runId: "run_1", blockId })).outcome
        ).toBe("absent");
        // Cleanup runs after the fact, so a record that has already expired is not an error.
        expect(
          (await store.unregisterWatcher({ waitpointId: "w_gone", runId: "run_1", blockId }))
            .outcome
        ).toBe("missing");
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "a run that goes terminal before completion leaves no fanout owed",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await store.registerBlocks({ runId: "run_1", blockId: BLOCK, edges: [edge("w_a")] });

        const released = await store.releaseRunWatchers({ runId: "run_1", reason: "terminal" });
        expect(released.unregistered).toBe(1);
        expect(released.cleanup.outcome).toBe("armed");

        // With no live watcher left, completion owes nothing: a completed waitpoint must
        // not keep fanning out to a run that will never resume.
        const completed = await store.complete({ waitpointId: "w_a", completion: completion() });
        expect(completed.fanout).toBe("absent");
        expect((await worker(store).runOnce()).visits).toEqual([]);
        expect(await receiptFor(probe, "run_1", "w_a")).toBeNull();

        // The withdrawn watcher's queue entry goes with it, rather than sitting on a key
        // with no reader and no TTL.
        expect(await probe.exists(waitpointKeys("w_a").queue)).toBe(0);
        expect(await probe.pttl(waitpointKeys("w_a").record)).toBeGreaterThan(0);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "a terminal run refuses a delivery that is already in flight",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });

        // Cancelled after the flip, so the watcher hash entry is gone but the page was
        // already claimed. Model the harder case: the hash entry survives and the RUN is the
        // one that has gone terminal.
        await store.cleanupRunBlockState({ runId: "run_1", reason: "cancelled" });

        const tick = await worker(store).runOnce();
        expect(tick.visits[0]).toMatchObject({ rejected: 1, delivered: 0, outcome: "drained" });
        expect(await receiptFor(probe, "run_1", "w_a")).toBeNull();
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );
});

describe("retention", () => {
  redisTest("no active key carries a TTL", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await pending(store, "w_a");
      await blockRuns(store, "w_a", ["run_1"]);

      const wp = waitpointKeys("w_a");
      // Pending waitpoint plus an active watcher registration.
      for (const key of [wp.record, wp.watchers, wp.queue]) {
        expect(await probe.pttl(key)).toBe(-1);
      }
      // Active run block state.
      for (const suffix of ["pend", "edge", "st"]) {
        expect(await probe.pttl(`wp:v1:run:{run_1}:${suffix}`)).toBe(-1);
      }

      // Completed with fanout still owed: incomplete fanout is active state.
      await store.complete({ waitpointId: "w_a", completion: completion() });
      for (const key of [wp.record, wp.watchers, wp.queue, wp.fanout]) {
        expect(await probe.pttl(key)).toBe(-1);
      }
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("cleaning up a run that never blocked writes nothing", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      // Safe to call for every terminal run: one tombstone per run, each carrying a
      // fortnight's TTL, would be a real cost for runs that never had a blocker.
      expect(
        await store.cleanupRunBlockState({ runId: "run_never_blocked", reason: "terminal" })
      ).toEqual({ outcome: "armed", handoffWas: "none", state: "absent" });

      expect(await probe.exists("wp:v1:run:{run_never_blocked}:st")).toBe(0);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest(
    "an absorb onto a TERMINAL run partition is refused, mutating nothing",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await store.absorbBlockers({ runId: "run_1", blockId: "blk_one", edges: [edge("w_a")] });
        await store.cleanupRunBlockState({ runId: "run_1", reason: "terminal" });
        const ttlBefore = await probe.pttl("wp:v1:run:{run_1}:st");
        expect(ttlBefore).toBeGreaterThan(0);

        // A run through terminal cleanup is finished; re-blocking it would resurrect a
        // reclaimed partition. Previously this cleared `term` and the TTLs and carried on.
        const refused = await store.absorbBlockers({
          runId: "run_1",
          blockId: "blk_two",
          edges: [edge("w_b")],
          expectedPreviousBlockId: "blk_one",
        });

        expect(refused.outcome).toBe("terminal");
        // Nothing moved: the partition is still expiring and still terminal, and the new
        // block was not installed.
        expect(await probe.pttl("wp:v1:run:{run_1}:st")).toBeGreaterThan(0);
        const state = await store.readBlockState("run_1");
        expect(state.terminal).toBe(true);
        expect(state.blockId).toBe("blk_one");
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );
});

describe("the durable resume handoff", () => {
  redisTest(
    "receipts are retained and no TTL is armed until the handoff is acknowledged",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await store.registerBlocks({ runId: "run_1", blockId: BLOCK, edges: [edge("w_a")] });
        await store.complete({ waitpointId: "w_a", completion: completion() });
        await worker(store).runOnce();

        // Every blocker met, so the run owes TRES a durable resume transition.
        const owed = await store.readBlockState("run_1");
        expect(owed.handoff).toBe("owed");
        expect(owed.pendingIds).toEqual([]);
        expect(owed.deliveredIds).toEqual(["w_a"]);

        const refused = await store.cleanupRunBlockState({ runId: "run_1", reason: "resume" });
        expect(refused).toEqual({ outcome: "retained", reason: "handoff-owed" });
        // The receipt survives a failed transition, and nothing is expiring.
        expect(await receiptFor(probe, "run_1", "w_a")).not.toBeNull();
        expect(await probe.pttl("wp:v1:run:{run_1}:done")).toBe(-1);
        expect(await probe.pttl("wp:v1:run:{run_1}:st")).toBe(-1);

        const acked = await store.acknowledgeResumeHandoff({ runId: "run_1", blockId: BLOCK });
        expect(acked.outcome).toBe("acknowledged");
        expect((await store.readBlockState("run_1")).handoff).toBe("acked");

        const armed = await store.cleanupRunBlockState({ runId: "run_1", reason: "resume" });
        expect(armed).toEqual({ outcome: "armed", handoffWas: "acked", state: "present" });
        expect(await probe.pttl("wp:v1:run:{run_1}:st")).toBeGreaterThan(0);
        expect(await probe.pttl("wp:v1:run:{run_1}:done")).toBeGreaterThan(0);
        // Expired, never deleted: the receipts stay readable for the window.
        expect(await receiptFor(probe, "run_1", "w_a")).not.toBeNull();
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest("acknowledging drains the block's edges when asked to", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await pending(store, "w_a");
      await store.registerBlocks({ runId: "run_1", blockId: BLOCK, edges: [edge("w_a")] });
      await store.complete({ waitpointId: "w_a", completion: completion() });
      await worker(store).runOnce();

      await store.acknowledgeResumeHandoff({
        runId: "run_1",
        blockId: BLOCK,
        edgeIds: [edgeField("w_a")],
      });

      const state = await store.readBlockState("run_1");
      expect(state.edges).toEqual([]);
      expect(state.deliveredIds).toEqual([]);
      expect(await probe.exists("wp:v1:run:{run_1}:done")).toBe(0);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("an acknowledgement for a superseded block is refused", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.absorbBlockers({ runId: "run_1", blockId: "blk_two", edges: [edge("w_b")] });

      expect(await store.acknowledgeResumeHandoff({ runId: "run_1", blockId: "blk_one" })).toEqual({
        outcome: "stale",
        currentBlockId: "blk_two",
      });
      expect(
        await store.acknowledgeResumeHandoff({ runId: "run_unknown", blockId: "blk_one" })
      ).toEqual({ outcome: "unknown", currentBlockId: undefined });
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "cancellation discharges an outstanding handoff rather than stranding the partition",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await store.registerBlocks({ runId: "run_1", blockId: BLOCK, edges: [edge("w_a")] });
        await store.complete({ waitpointId: "w_a", completion: completion() });
        await worker(store).runOnce();
        expect((await store.readBlockState("run_1")).handoff).toBe("owed");

        // A cancelled run will never publish a resume transition, so there is nothing left
        // to wait for. Refusing here would leave the partition unreclaimable forever.
        const armed = await store.cleanupRunBlockState({ runId: "run_1", reason: "cancelled" });
        expect(armed).toEqual({ outcome: "armed", handoffWas: "owed", state: "present" });
        expect(await probe.pttl("wp:v1:run:{run_1}:st")).toBeGreaterThan(0);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "a superseding block operation clears the previous one's obligation",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.absorbBlockers({ runId: "run_1", blockId: "blk_one", edges: [edge("w_a")] });
        await store.deliverCompletion({
          runId: "run_1",
          blockId: "blk_one",
          waitpointId: "w_a",
          completion: completion(),
        });
        expect((await store.readBlockState("run_1")).handoff).toBe("owed");

        // A run that is blocking again has necessarily already resumed.
        await store.absorbBlockers({
          runId: "run_1",
          blockId: "blk_two",
          edges: [edge("w_b")],
          expectedPreviousBlockId: "blk_one",
        });
        const state = await store.readBlockState("run_1");
        expect(state.blockId).toBe("blk_two");
        expect(state.handoff).toBe("none");
      } finally {
        await store.quit();
      }
    }
  );
});

describe("high watcher cardinality", () => {
  redisTest(
    "foreground completion and every command stay bounded at 500 watchers",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      const WATCHERS = 500;
      const PAGE = 50;
      try {
        await pending(store, "w_one");
        await pending(store, "w_many");
        await blockRuns(store, "w_one", ["run_solo"]);
        await blockRuns(
          store,
          "w_many",
          Array.from({ length: WATCHERS }, (_, i) => `run_${i}`)
        );

        // Warm the scripts first: a cold EVALSHA falls back to EVAL, and that retry would
        // differ between the two captures for a reason that has nothing to do with width.
        await pending(store, "w_warm");
        await store.complete({ waitpointId: "w_warm", completion: completion() });

        // Every command this process issues, captured at the ioredis dispatch point. The
        // argument count is the wire size, so a command that grew with watcher count would
        // show up here as a wider call rather than only as a slower one.
        const sent = captureCommands();
        try {
          await store.complete({ waitpointId: "w_one", completion: completion() });
          const solo = sent.take();
          await store.complete({ waitpointId: "w_many", completion: completion() });
          const many = sent.take();

          // Identical shape at 1 watcher and at 500: same commands, same widths.
          expect(many.map((c) => c.name)).toEqual(solo.map((c) => c.name));
          expect(many.map((c) => c.args.length)).toEqual(solo.map((c) => c.args.length));
          expect(Math.max(...many.map((c) => c.args.length))).toBeLessThan(20);
        } finally {
          sent.restore();
        }

        const fanoutWorker = worker(store, { pageSize: PAGE, maxPagesPerVisit: 100 });
        const summary = await fanoutWorker.visit("w_many");

        expect(summary).toMatchObject({ delivered: WATCHERS, outcome: "drained" });
        expect(summary.pages).toBe(WATCHERS / PAGE);
        expect(await probe.exists(waitpointKeys("w_many").queue)).toBe(0);
        expect(await receiptFor(probe, "run_499", "w_many")).not.toBeNull();
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );
});

describe("primary-only authoritative operations", () => {
  redisTest(
    "every authoritative read and write is a script, never a bare command",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);

        const sent = captureCommands();
        try {
          // A representative slice of the whole protocol, including the read-only paths.
          await store.complete({ waitpointId: "w_a", completion: completion() });
          await worker(store).runOnce();
          await store.readBlockState("run_1");
          await store.describeWaitpoint("w_a");
          await store.fanoutBacklog();
          await store.acknowledgeResumeHandoff({ runId: "run_1", blockId: `${BLOCK}_run_1` });
          await store.cleanupRunBlockState({ runId: "run_1", reason: "resume" });
          await store.registerOrReport({
            waitpointId: "w_a",
            runId: "run_2",
            blockId: BLOCK,
            createdAt: NOW,
          });

          const issued = sent.take();
          expect(issued.length).toBeGreaterThan(10);
          // EVAL and EVALSHA are always routed to the slot's primary. A bare ZRANGEBYSCORE
          // or HGET here would be eligible for a replica read under scaleReads, which is
          // exactly the stale authoritative read this protocol must not make.
          const nonScript = issued.filter(
            (c) => !["eval", "evalsha", "script"].includes(c.name.toLowerCase())
          );
          expect(nonScript.map((c) => c.name)).toEqual([]);
        } finally {
          sent.restore();
        }
      } finally {
        await store.quit();
      }
    }
  );
});

describe("inertness while store-resident waitpoint minting is disabled", () => {
  redisTest("a worker defaults to disabled and start() does nothing", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await pending(store, "w_a");
      await blockRuns(store, "w_a", ["run_1"]);
      await store.complete({ waitpointId: "w_a", completion: completion() });

      const idle = new WaitpointFanoutWorker({ coordinator: store });
      expect(idle.enabled).toBe(false);
      idle.start();
      await idle.stop();

      // start() scheduled nothing, so the owed work is still owed and nothing was delivered.
      expect(await receiptFor(probe, "run_1", "w_a")).toBeNull();
      expect(await probe.llen(waitpointKeys("w_a").queue)).toBe(1);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });
});

type SentCommand = { name: string; args: unknown[] };

describe("metrics", () => {
  redisTest(
    "reports completion, delivery and backlog through a real meter",
    async ({ redisOptions }) => {
      // A real OTel meter over an in-memory exporter, so this exercises the same pipeline
      // production reads rather than asserting that a spy was called.
      const { meter, getCounterValue } = createTestMetricsMeter();
      const store = new WaitpointStoreCoordinator({
        redisOptions,
        terminalRetentionMs: RETENTION_MS,
        meter,
      });
      try {
        await pending(store, "w_a");
        await pending(store, "w_undelivered");
        await blockRuns(store, "w_a", ["run_keep", "run_cancel"]);
        await blockRuns(store, "w_undelivered", ["run_other"]);
        await store.unregisterWatcher({
          waitpointId: "w_a",
          runId: "run_cancel",
          blockId: `${BLOCK}_run_cancel`,
        });

        await store.complete({ waitpointId: "w_a", completion: completion() });
        await store.complete({ waitpointId: "w_undelivered", completion: completion() });

        const fanoutWorker = new WaitpointFanoutWorker({
          coordinator: store,
          enabled: true,
          workerId: "worker-metrics",
          leaseMs: LEASE_MS,
          meter,
        });
        await fanoutWorker.visit("w_a");
        await store.deliverCompletion({
          runId: "run_keep",
          blockId: `${BLOCK}_run_keep`,
          waitpointId: "w_a",
          completion: completion(),
        });
        await store.cleanupRunBlockState({ runId: "run_keep", reason: "resume" });

        expect(await getCounterValue("waitpoint.store.completions", { fanout: "pending" })).toBe(2);
        expect(
          await getCounterValue("waitpoint.store.registrations", { outcome: "registered" })
        ).toBe(3);
        expect(await getCounterValue("waitpoint.store.watchers_unregistered")).toBe(1);
        expect(
          await getCounterValue("waitpoint.store.run_deliveries", { outcome: "delivered" })
        ).toBe(1);
        expect(
          await getCounterValue("waitpoint.store.run_deliveries", { outcome: "duplicate" })
        ).toBe(1);
        expect(await getCounterValue("waitpoint.store.run_cleanups", { outcome: "retained" })).toBe(
          1
        );

        expect(
          await getCounterValue("waitpoint.fanout.watchers_delivered", { outcome: "delivered" })
        ).toBe(1);
        expect(await getCounterValue("waitpoint.fanout.stale_watchers")).toBe(1);
        expect(await getCounterValue("waitpoint.fanout.pages_processed")).toBe(1);

        // The observable gauges share one batch callback, so a single flush resolves all
        // three from one backlog read. w_undelivered is still owed.
        expect(await getCounterValue("waitpoint.fanout.backlog")).toBe(1);
        expect(await getCounterValue("waitpoint.fanout.quarantine_depth")).toBe(0);
      } finally {
        await store.quit();
      }
    }
  );
});

/**
 * Capture every command this process dispatches through ioredis.
 *
 * Patched onto the prototype, because the coordinator owns its client and must not grow a
 * production accessor for it. `sendCommand` is the single funnel every built-in wrapper and
 * every `defineCommand` script passes through, so nothing issued from Node escapes it —
 * while commands Redis runs INSIDE a script are never dispatched from here, which is
 * precisely the distinction these tests assert on.
 */
function captureCommands() {
  const proto = Redis.prototype as unknown as {
    sendCommand: (this: unknown, command: SentCommand, ...rest: unknown[]) => unknown;
  };
  const original = proto.sendCommand;
  let sent: SentCommand[] = [];

  proto.sendCommand = function patched(this: unknown, command: SentCommand, ...rest: unknown[]) {
    sent.push({ name: command.name, args: command.args ?? [] });
    return original.call(this, command, ...rest);
  };

  return {
    take(): SentCommand[] {
      const taken = sent;
      sent = [];
      return taken;
    },
    restore(): void {
      proto.sendCommand = original;
    },
  };
}

describe("worker construction ceilings", () => {
  redisTest("refuses a page size above the ceiling", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      expect(() => new WaitpointFanoutWorker({ coordinator: store, pageSize: 1_001 })).toThrow(
        /pageSize must be <= 1000/
      );
      expect(() => new WaitpointFanoutWorker({ coordinator: store, dueBatchSize: 1_001 })).toThrow(
        /dueBatchSize must be <= 1000/
      );
      expect(
        () => new WaitpointFanoutWorker({ coordinator: store, maxPagesPerVisit: 101 })
      ).toThrow(/maxPagesPerVisit must be <= 100/);
      expect(
        () => new WaitpointFanoutWorker({ coordinator: store, deliveryConcurrency: 101 })
      ).toThrow(/deliveryConcurrency must be <= 100/);
    } finally {
      await store.quit();
    }
  });

  redisTest("refuses an unbounded aggregate visit", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      expect(
        () =>
          new WaitpointFanoutWorker({
            coordinator: store,
            pageSize: 1_000,
            maxPagesPerVisit: 100,
          })
      ).toThrow(/must be <= 10000/);
    } finally {
      await store.quit();
    }
  });

  redisTest("accepts every setting at its maximum", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      expect(
        () =>
          new WaitpointFanoutWorker({
            coordinator: store,
            pageSize: 1_000,
            dueBatchSize: 1_000,
            maxPagesPerVisit: 10,
            deliveryConcurrency: 100,
          })
      ).not.toThrow();
    } finally {
      await store.quit();
    }
  });
});

/**
 * One serialization per claimed page, not one per watcher.
 *
 * Observed by identity rather than by counting: every delivery from one claim must receive the
 * SAME encoded object. If the worker went back to serializing per watcher each delivery would
 * carry a distinct object, so a single `Set` of what arrived is the whole assertion — and it
 * stays true against real Redis, with no stubbing of the delivery itself.
 */
describe("completion encoding reuse", () => {
  class RecordingCoordinator extends WaitpointStoreCoordinator {
    readonly encodedSeen: object[] = [];
    readonly perWatcherSerializations: number[] = [];

    override async deliverEncodedCompletion(
      args: Parameters<WaitpointStoreCoordinator["deliverEncodedCompletion"]>[0]
    ) {
      this.encodedSeen.push(args.encoded);
      return super.deliverEncodedCompletion(args);
    }

    override async deliverCompletion(
      args: Parameters<WaitpointStoreCoordinator["deliverCompletion"]>[0]
    ) {
      // The per-watcher path: reaching it at all from fanout is the regression.
      this.perWatcherSerializations.push(1);
      return super.deliverCompletion(args);
    }
  }

  redisTest(
    "one encoded completion is reused across every watcher on a page",
    async ({ redisOptions }) => {
      const store = new RecordingCoordinator({
        redisOptions,
        terminalRetentionMs: RETENTION_MS,
      });
      const probe = createRedisClient(redisOptions);
      try {
        const runIds = Array.from({ length: 8 }, (_, i) => `run_${i}`);
        await pending(store, "w_a");
        await blockRuns(store, "w_a", runIds);
        await store.complete({ waitpointId: "w_a", completion: completion() });

        // One page, so one claim, so one encoding.
        const summary = await worker(store, { pageSize: 8 }).visit("w_a");
        expect(summary).toMatchObject({ pages: 1, delivered: 8, outcome: "drained" });

        expect(store.encodedSeen).toHaveLength(8);
        expect(new Set(store.encodedSeen).size).toBe(1);
        expect(store.perWatcherSerializations).toHaveLength(0);

        // And the envelope every run received is unchanged.
        for (const runId of runIds) {
          expect(JSON.parse((await receiptFor(probe, runId, "w_a"))!)).toEqual(completion());
        }
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest("each page encodes once, so two pages encode twice", async ({ redisOptions }) => {
    const store = new RecordingCoordinator({
      redisOptions,
      terminalRetentionMs: RETENTION_MS,
    });
    try {
      const runIds = Array.from({ length: 8 }, (_, i) => `run_${i}`);
      await pending(store, "w_a");
      await blockRuns(store, "w_a", runIds);
      await store.complete({ waitpointId: "w_a", completion: completion() });

      const summary = await worker(store, { pageSize: 4 }).visit("w_a");
      expect(summary).toMatchObject({ pages: 2, delivered: 8, outcome: "drained" });

      // Per CLAIM, which is the reuse boundary a lease can guarantee — not per visit, because a
      // later page may be claimed by a different worker after a reclaim.
      expect(store.encodedSeen).toHaveLength(8);
      expect(new Set(store.encodedSeen).size).toBe(2);
    } finally {
      await store.quit();
    }
  });
});

/**
 * The poison row: a STORED envelope this worker cannot encode.
 *
 * Reachable without any caller misbehaving — an older worker wrote it under a higher ceiling,
 * or the ceiling was lowered under a rolling deploy. Before this was handled, the throw escaped
 * `visit`, the claim sat until its lease lapsed, the failure streak never moved, and the record
 * was re-claimed forever. It must instead progress to a terminal disposition.
 */
describe("an undeliverable stored completion", () => {
  // Written straight to the record, which is exactly what an older worker leaves behind. The
  // coordinator's own write path would refuse this envelope now.
  async function poison(store: WaitpointStoreCoordinator, probe: Redis, id = "w_a") {
    await pending(store, id);
    await blockRuns(store, id, ["run_1"]);
    await store.complete({ waitpointId: id, completion: completion() });
    await probe.hset(
      waitpointKeys(id).record,
      "c",
      JSON.stringify({
        ...completion(),
        output: { inline: "x".repeat(MAX_INLINE_COMPLETION_OUTPUT_BYTES + 1) },
      })
    );
  }

  redisTest(
    "backs off with an undeliverable marker instead of holding the claim",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const clock = fakeClock();
      const probe = createRedisClient(redisOptions);
      try {
        await poison(store, probe);
        const fanout = waitpointKeys("w_a").fanout;
        const now = Date.now();
        clock.set(now);

        const visit = await worker(store, { clock: clock.now }).visit("w_a");

        // Released, marked, and counted — not an escaped exception.
        expect(visit).toMatchObject({ outcome: "released", undeliverable: true, failures: 1 });
        // The claim is gone, so nothing waits on a lease to lapse.
        expect(await probe.hget(fanout, "owner")).toBe("");
        expect(await probe.hget(fanout, "fail")).toBe("1");
        // And nothing was delivered.
        expect(await receiptFor(probe, "run_1", "w_a")).toBeNull();
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest("the failure streak progresses to quarantine", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const clock = fakeClock();
    const probe = createRedisClient(redisOptions);
    try {
      await poison(store, probe);
      const keys = waitpointKeys("w_a");
      const partition = fanoutPartition("w_a");
      const MAX = 3;

      const failing = new WaitpointFanoutWorker({
        clock: clock.now,
        coordinator: store,
        enabled: true,
        workerId: "worker-a",
        leaseMs: LEASE_MS,
        retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 4_000, maxFailures: MAX },
      });

      let at = Date.now();
      const outcomes: string[] = [];
      for (let attempt = 1; attempt <= MAX; attempt++) {
        clock.set(at);
        const visit = await failing.visit("w_a");
        outcomes.push(visit.outcome);
        expect(visit.undeliverable).toBe(true);
        expect(await probe.hget(keys.fanout, "fail")).toBe(String(attempt));
        at += 60_000;
      }

      // Bounded: it gives up rather than retrying forever.
      expect(outcomes).toEqual(["released", "released", "quarantined"]);
      expect(await probe.hget(keys.fanout, "state")).toBe("quarantined");
      // Out of the due index, so no sweep finds it again.
      expect(await probe.zscore(fanoutIndexKeys(partition).due, "w_a")).toBeNull();
      expect(await probe.zscore(fanoutIndexKeys(partition).quarantine, "w_a")).not.toBeNull();
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("a healthy waitpoint behind a poison one still drains", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await poison(store, probe, "w_bad");
      await pending(store, "w_good");
      await blockRuns(store, "w_good", ["run_good"]);
      await store.complete({ waitpointId: "w_good", completion: completion() });

      // One tick, both entries. The poison one must not take the sweep down with it.
      const tick = await worker(store).runOnce();
      const byId = new Map(tick.visits.map((v) => [v.waitpointId, v]));

      expect(byId.get("w_bad")).toMatchObject({ undeliverable: true, outcome: "released" });
      expect(byId.get("w_good")).toMatchObject({ delivered: 1, outcome: "drained" });
      expect(await receiptFor(probe, "run_good", "w_good")).not.toBeNull();
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });
});

/**
 * `dispose()` must not return while a metric collection is still reading.
 *
 * The `disposed` guard is checked ONCE, at the top of the callback, and the backlog read after
 * it awaits across every partition. A collection that passed the guard before `dispose()` ran
 * was therefore still reading when the caller — following the documented dispose-then-close
 * order — closed the coordinator underneath it.
 *
 * Driven by a barrier rather than a timer: the read is held open at a known point, so the
 * assertion that disposal is still pending is a fact about ordering, not about elapsed time.
 */
describe("disposal and active metric collection", () => {
  redisTest("dispose awaits a collection already in flight", async ({ redisOptions }) => {
    const { meter, getCounterValue } = createTestMetricsMeter();
    const store = new WaitpointStoreCoordinator({
      redisOptions,
      terminalRetentionMs: RETENTION_MS,
    });

    let entered!: () => void;
    const hasEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const realBacklog = store.fanoutBacklog.bind(store);
    let reads = 0;
    store.fanoutBacklog = async () => {
      reads++;
      entered();
      // Held open PAST the point the callback checked `disposed`.
      await held;
      return realBacklog();
    };

    try {
      const observed = new WaitpointFanoutWorker({
        coordinator: store,
        enabled: true,
        workerId: "worker-dispose-race",
        leaseMs: LEASE_MS,
        meter,
      });

      // Floating deliberately: awaiting the collection here would deadlock on the barrier.
      const collecting = getCounterValue("waitpoint.fanout.backlog");
      await hasEntered;
      expect(reads).toBe(1);

      let disposalSettled = false;
      const disposal = observed.dispose().then(() => {
        disposalSettled = true;
      });

      // A macrotask boundary, not a sleep: enough for every microtask dispose() can run
      // without the barrier to have run. It cannot have finished, because the read is held.
      await new Promise((resolve) => setImmediate(resolve));
      expect(disposalSettled).toBe(false);

      release();
      await disposal;
      expect(disposalSettled).toBe(true);
      await collecting;

      // Only NOW is it safe for the caller to close the coordinator, which is the whole
      // contract dispose() exists to provide.
      expect(reads).toBe(1);
    } finally {
      await store.quit();
    }
  });

  redisTest("a collection that throws still clears the tracking set", async ({ redisOptions }) => {
    const { meter, getCounterValue } = createTestMetricsMeter();
    const store = new WaitpointStoreCoordinator({
      redisOptions,
      terminalRetentionMs: RETENTION_MS,
    });
    store.fanoutBacklog = async () => {
      throw new Error("backlog read failed");
    };

    try {
      const observed = new WaitpointFanoutWorker({
        coordinator: store,
        enabled: true,
        workerId: "worker-dispose-throw",
        leaseMs: LEASE_MS,
        meter,
      });

      // A rejected collection left in the set would make dispose() hang forever on a
      // promise nobody settles again.
      await getCounterValue("waitpoint.fanout.backlog").catch(() => undefined);
      await expect(observed.dispose()).resolves.toBeUndefined();
    } finally {
      await store.quit();
    }
  });
});

/**
 * Concurrent `dispose()` calls must share ONE operation.
 *
 * A flag plus a partial re-run was not enough: the second caller saw `disposed === true`,
 * drained only the metric collections, and could return while the first was still inside
 * `stop()` awaiting a worker tick — then close the coordinator under that tick. This holds a
 * TICK open rather than a metric collection, which is the case the flag missed.
 */
describe("concurrent disposal shares one barrier", () => {
  redisTest(
    "both calls stay pending until the worker tick is released",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);

      let entered!: () => void;
      const hasEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      // The tick's first act is the due-index sweep, so holding that holds the tick.
      const realDue = store.dueFanoutEntries.bind(store);
      let sweeps = 0;
      store.dueFanoutEntries = async (args) => {
        if (++sweeps === 1) {
          entered();
          await held;
        }
        return realDue(args);
      };

      try {
        const running = new WaitpointFanoutWorker({
          coordinator: store,
          enabled: true,
          workerId: "worker-concurrent-dispose",
          leaseMs: LEASE_MS,
          pollIntervalMs: 1,
        });
        running.start();
        await hasEntered;

        let firstSettled = false;
        let secondSettled = false;
        const first = running.dispose().then(() => {
          firstSettled = true;
        });
        const second = running.dispose().then(() => {
          secondSettled = true;
        });

        // A macrotask boundary, not a sleep. The second call is the one that used to return
        // here, because the collection set was empty and the flag was already set.
        await new Promise((resolve) => setImmediate(resolve));
        expect(firstSettled).toBe(false);
        expect(secondSettled).toBe(false);

        release();
        await Promise.all([first, second]);
        expect(firstSettled).toBe(true);
        expect(secondSettled).toBe(true);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("a later dispose awaits the same completed operation", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const disposable = new WaitpointFanoutWorker({
        coordinator: store,
        enabled: true,
        workerId: "worker-dispose-again",
        leaseMs: LEASE_MS,
      });

      await disposable.dispose();
      // Still idempotent, and still resolves — the memoised promise is already settled.
      await expect(disposable.dispose()).resolves.toBeUndefined();
      await expect(disposable.dispose()).resolves.toBeUndefined();
    } finally {
      await store.quit();
    }
  });
});

/**
 * `start()` must not be able to overtake a `stop()` that is still draining.
 *
 * `stop()` set `draining` and awaited the tick; a `start()` arriving in that window cleared
 * `draining` and installed a new timer, so the pending `stop()` returned while fanout work
 * carried on — and its caller then closed the coordinator under that work.
 */
describe("start/stop lifecycle is serialized", () => {
  function heldSweep(store: WaitpointStoreCoordinator) {
    let entered!: () => void;
    const hasEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = store.dueFanoutEntries.bind(store);
    let sweeps = 0;
    store.dueFanoutEntries = async (args) => {
      if (++sweeps === 1) {
        entered();
        await held;
      }
      return real(args);
    };
    return { hasEntered, release: () => release() };
  }

  redisTest("start() is rejected while a stop is draining", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const { hasEntered, release } = heldSweep(store);
    try {
      const running = new WaitpointFanoutWorker({
        coordinator: store,
        enabled: true,
        workerId: "worker-restart-race",
        leaseMs: LEASE_MS,
        pollIntervalMs: 1,
      });
      running.start();
      await hasEntered;

      let stopSettled = false;
      const stopping = running.stop().then(() => {
        stopSettled = true;
      });

      // Loudly refused, not silently ignored: a caller told "restarted" would be wrong.
      expect(() => running.start()).toThrow(/stop\(\) is in progress/);
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopSettled).toBe(false);

      release();
      await stopping;
      expect(stopSettled).toBe(true);

      // And once the stop has settled, a restart is legal and the worker processes again.
      await pending(store, "w_a");
      await blockRuns(store, "w_a", ["run_1"]);
      await store.complete({ waitpointId: "w_a", completion: completion() });

      expect(() => running.start()).not.toThrow();
      // Stopped again before asserting, so the restarted interval cannot race the
      // direct-drive tick for the same work and make the assertion order-dependent.
      await running.stop();
      const probe = createRedisClient(redisOptions);
      try {
        await running.runOnce();
        expect(await receiptFor(probe, "run_1", "w_a")).not.toBeNull();
      } finally {
        probe.disconnect();
      }
    } finally {
      await store.quit();
    }
  });

  redisTest("concurrent stop callers await the same tick", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const { hasEntered, release } = heldSweep(store);
    try {
      const running = new WaitpointFanoutWorker({
        coordinator: store,
        enabled: true,
        workerId: "worker-stop-shared",
        leaseMs: LEASE_MS,
        pollIntervalMs: 1,
      });
      running.start();
      await hasEntered;

      let first = false;
      let second = false;
      const a = running.stop().then(() => {
        first = true;
      });
      const b = running.stop().then(() => {
        second = true;
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect([first, second]).toEqual([false, false]);

      release();
      await Promise.all([a, b]);
      expect([first, second]).toEqual([true, true]);
    } finally {
      await store.quit();
    }
  });

  redisTest("no timer survives a completed stop", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const running = new WaitpointFanoutWorker({
        coordinator: store,
        enabled: true,
        workerId: "worker-no-timer",
        leaseMs: LEASE_MS,
        pollIntervalMs: 1,
      });
      running.start();
      await running.stop();

      // A surviving interval would keep sweeping; nothing here counts sweeps, so the proxy
      // is that a second stop is an immediate no-op and disposal stays terminal.
      await running.stop();
      await running.dispose();
      expect(() => running.start()).toThrow(/after dispose\(\)/);
    } finally {
      await store.quit();
    }
  });
});

/**
 * `dispose()` must await direct-drive work too.
 *
 * `#assertNotDisposed` guards ENTRY only, and `stop()` awaits `inFlight`, which only a
 * timer-started tick ever sets. A direct `runOnce()` or `visit()` therefore held nothing
 * open: disposal returned mid-page and its caller closed the coordinator under a live claim.
 */
describe("disposal awaits direct-drive work", () => {
  function barrier() {
    let entered!: () => void;
    const hasEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { hasEntered, entered: () => entered(), held, release: () => release() };
  }

  async function owedWaitpoint(store: WaitpointStoreCoordinator) {
    await pending(store, "w_a");
    await blockRuns(store, "w_a", ["run_1"]);
    await store.complete({ waitpointId: "w_a", completion: completion() });
  }

  redisTest("a direct visit() holds disposal open", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const b = barrier();
    try {
      await owedWaitpoint(store);

      // Paused AFTER the visit has begun its Redis work, holding a real claim.
      const realClaim = store.claimFanoutPage.bind(store);
      let claims = 0;
      store.claimFanoutPage = async (args) => {
        if (++claims === 1) {
          b.entered();
          await b.held;
        }
        return realClaim(args);
      };

      const worker0 = worker(store, { workerId: "worker-direct-visit" });
      const visiting = worker0.visit("w_a");
      await b.hasEntered;

      let disposed = false;
      const disposal = worker0.dispose().then(() => {
        disposed = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(disposed).toBe(false);

      b.release();
      // The admitted visit settles NORMALLY — the claim is not abandoned mid-page.
      expect(await visiting).toMatchObject({ delivered: 1, outcome: "drained" });
      await disposal;
      expect(disposed).toBe(true);
    } finally {
      await store.quit();
    }
  });

  redisTest("a direct runOnce() holds disposal open", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const b = barrier();
    try {
      await owedWaitpoint(store);

      const realDue = store.dueFanoutEntries.bind(store);
      let sweeps = 0;
      store.dueFanoutEntries = async (args) => {
        if (++sweeps === 1) {
          b.entered();
          await b.held;
        }
        return realDue(args);
      };

      const worker0 = worker(store, { workerId: "worker-direct-tick" });
      const ticking = worker0.runOnce();
      await b.hasEntered;

      let disposed = false;
      const disposal = worker0.dispose().then(() => {
        disposed = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(disposed).toBe(false);

      b.release();
      await ticking;
      await disposal;
      expect(disposed).toBe(true);
    } finally {
      await store.quit();
    }
  });

  redisTest("a REJECTED direct operation cannot wedge disposal", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await owedWaitpoint(store);
      store.claimFanoutPage = async () => {
        throw new Error("claim exploded");
      };

      const worker0 = worker(store, { workerId: "worker-direct-throw" });
      await expect(worker0.visit("w_a")).rejects.toThrow("claim exploded");

      // Removed in the finally, so the set is empty and disposal is not waiting on a promise
      // nobody will settle again.
      await expect(worker0.dispose()).resolves.toBeUndefined();
    } finally {
      await store.quit();
    }
  });

  redisTest("operations entering after disposal still fail at once", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const worker0 = worker(store, { workerId: "worker-direct-after" });
      await worker0.dispose();

      await expect(worker0.visit("w_a")).rejects.toThrow(/after dispose\(\)/);
      await expect(worker0.runOnce()).rejects.toThrow(/after dispose\(\)/);
      expect(() => worker0.start()).toThrow(/after dispose\(\)/);
    } finally {
      await store.quit();
    }
  });

  redisTest("a tick's nested visits are not double-tracked", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await owedWaitpoint(store);
      const worker0 = worker(store, { workerId: "worker-nested" });

      // runOnce() calls the PRIVATE visit implementation, so the tick is one tracked entry
      // rather than one per waitpoint it sweeps. Observable as ordinary completion: a
      // double-tracked nested promise would still be in the set when the tick resolved and
      // would make this dispose() hang.
      const tick = await worker0.runOnce();
      expect(tick.visits[0]).toMatchObject({ delivered: 1, outcome: "drained" });
      await expect(worker0.dispose()).resolves.toBeUndefined();
    } finally {
      await store.quit();
    }
  });
});

describe("a quarantined claim reports failures, not attempts", () => {
  redisTest(
    "the refusal carries the failure streak and not the claim count",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const clock = fakeClock();
      const probe = createRedisClient(redisOptions);
      try {
        await pending(store, "w_a");
        await blockRuns(store, "w_a", ["run_1"]);
        await store.complete({ waitpointId: "w_a", completion: completion() });
        // Unroutable, so every delivery attempt stalls and the entry backs off.
        await probe.hset(
          waitpointKeys("w_a").watchers,
          blockedWatcherField("run_1"),
          JSON.stringify({ runId: "", blockId: `${BLOCK}_run_1`, createdAt: NOW })
        );

        const MAX = 2;
        const failing = new WaitpointFanoutWorker({
          clock: clock.now,
          coordinator: store,
          enabled: true,
          workerId: "worker-a",
          leaseMs: LEASE_MS,
          retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 4_000, maxFailures: MAX },
        });

        let at = Date.now();
        for (let attempt = 1; attempt <= MAX; attempt++) {
          clock.set(at);
          await failing.visit("w_a");
          at += 60_000;
        }
        const fanout = waitpointKeys("w_a").fanout;
        expect(await probe.hget(fanout, "state")).toBe("quarantined");

        // Each visit here both claims and fails, so att and fail track each other exactly and
        // a reply carrying either would look identical. Forced apart so the assertion below
        // can only pass for one of them. In production they diverge on their own: att also
        // counts successful pages, which is the whole defect.
        const failures = Number(await probe.hget(fanout, "fail"));
        await probe.hset(fanout, "att", "99");
        expect(failures).not.toBe(99);

        clock.set(at);
        const refused = await store.claimFanoutPage({
          waitpointId: "w_a",
          workerId: "worker-b",
          pageSize: 10,
          leaseMs: LEASE_MS,
          now: clock.now(),
        });

        expect(refused.outcome).toBe("quarantined");
        expect(refused).toMatchObject({ failures });
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );
});
