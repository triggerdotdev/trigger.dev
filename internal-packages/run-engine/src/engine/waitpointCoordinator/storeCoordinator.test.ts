// Redis-only suite: the coordinator holds no Prisma reference, so no Postgres container
// is needed. redisTest FLUSHALLs before every test, so ids may be reused across describes.
import { createRedisClient, type RedisOptions } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import {
  deriveWaitpointIdFromAnchor,
  generateRunOpsId,
  generateWaitpointId,
} from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import {
  edgeField,
  idempotencyKey,
  runBlockKeys,
  watcherField,
  WaitpointKeyTagError,
} from "./keys.js";
import { registerWaitpointCommands } from "./scripts.js";
import {
  encodeCompletionForDelivery,
  EncodedWaitpointCompletion,
  MAX_INLINE_COMPLETION_OUTPUT_BYTES,
  WaitpointCompletionConflictError,
  WaitpointCompletionTooLargeError,
  WaitpointNotFoundError,
  WaitpointStoreCoordinator,
  type BlockEdge,
  type WaitpointCompletion,
  type WaitpointRecordInput,
  type WatcherEntry,
} from "./storeCoordinator.js";

const ENV_ID = "env_1";
const BLOCK_ID = "blk_1";
const PROJECT_ID = "proj_1";
const NOW = "2026-08-21T12:00:00.000Z";

function coordinator(redisOptions: RedisOptions) {
  return new WaitpointStoreCoordinator({ redisOptions });
}

/**
 * The watchers a completed waitpoint still owes a delivery, read through the same bounded
 * page the fanout worker claims. `complete` no longer returns them — returning every
 * watcher was the unbounded foreground read this work removed — so tests that care about
 * who is registered ask the queue.
 *
 * This TAKES a claim, so a test that also runs a real worker would find the entry busy.
 * No caller here does; the worker's own coverage lives in fanoutWorker.test.ts.
 */
async function queuedWatchers(
  store: WaitpointStoreCoordinator,
  waitpointId: string,
  pageSize = 100
): Promise<WatcherEntry[]> {
  const claim = await store.claimFanoutPage({
    waitpointId,
    workerId: "test-reader",
    pageSize,
    leaseMs: 60_000,
  });
  if (claim.outcome !== "claimed") {
    return [];
  }
  return claim.page.flatMap((entry) => (entry.watcher ? [entry.watcher] : []));
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

describe("createIfAbsent", () => {
  redisTest("creates a PENDING record and reports created", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const result = await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      expect(result.outcome).toBe("created");
    } finally {
      await store.quit();
    }
  });

  redisTest("returns the existing record on a second call", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      const second = await store.createIfAbsent({
        record: record("w_a", { friendlyId: "waitpoint_DIFFERENT" }),
        status: "PENDING",
      });

      expect(second.outcome).toBe("exists");
      if (second.outcome !== "exists") throw new Error("unreachable");
      // The first write wins: a retry must not overwrite the stored record.
      expect(second.record.friendlyId).toBe("waitpoint_w_a");
      expect(second.status).toBe("PENDING");
      expect(second.completion).toBeUndefined();
    } finally {
      await store.quit();
    }
  });

  redisTest("preserves every record field through a round trip", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const full = record("w_a", {
        type: "RUN",
        idempotencyKey: "key-1",
        userProvidedIdempotencyKey: true,
        idempotencyKeyExpiresAt: NOW,
        completedAfter: NOW,
        completedByTaskRunId: "run_child",
        completedByBatchId: "batch_1",
        tags: ["one", "two"],
      });

      await store.createIfAbsent({ record: full, status: "PENDING" });
      const read = await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });

      expect(read.outcome).toBe("exists");
      if (read.outcome !== "exists") throw new Error("unreachable");
      // Every field the frozen return shapes need must survive the blob round trip.
      expect(read.record).toEqual(full);
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "can create an already-COMPLETED record with no completion envelope",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        // This is the shape that catches a status-casing mismatch: the record is stored
        // COMPLETED, and a register must see it as completed rather than pending.
        await store.createIfAbsent({ record: record("w_a"), status: "COMPLETED" });

        const reported = await store.registerOrReport({
          blockId: BLOCK_ID,
          waitpointId: "w_a",
          runId: "run_1",
          createdAt: NOW,
        });

        expect(reported.outcome).toBe("completed");
        if (reported.outcome !== "completed") throw new Error("unreachable");
        expect(reported.completion).toBeUndefined();
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "can create an already-COMPLETED record with a completion",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({
          record: record("w_a", { type: "RUN" }),
          status: "COMPLETED",
          completion: completion(),
        });

        const reported = await store.registerOrReport({
          blockId: BLOCK_ID,
          waitpointId: "w_a",
          runId: "run_1",
          createdAt: NOW,
        });

        expect(reported.outcome).toBe("completed");
        if (reported.outcome !== "completed") throw new Error("unreachable");
        expect(reported.completion?.output).toEqual({ inline: '{"ok":true}' });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "reads a COMPLETED record back through createIfAbsent, with an envelope",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({
          record: record("w_a"),
          status: "COMPLETED",
          completion: completion(),
        });

        const second = await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });

        expect(second.outcome).toBe("exists");
        if (second.outcome !== "exists") throw new Error("unreachable");
        expect(second.status).toBe("COMPLETED");
        expect(second.completion?.output).toEqual({ inline: '{"ok":true}' });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "reads a COMPLETED record back through createIfAbsent, with no envelope",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "COMPLETED" });

        const second = await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });

        expect(second.outcome).toBe("exists");
        if (second.outcome !== "exists") throw new Error("unreachable");
        expect(second.status).toBe("COMPLETED");
        expect(second.completion).toBeUndefined();
      } finally {
        await store.quit();
      }
    }
  );
});

describe("registerOrReport", () => {
  redisTest("registers a watcher against a PENDING waitpoint", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      const result = await store.registerOrReport({
        blockId: BLOCK_ID,
        waitpointId: "w_a",
        runId: "run_1",
        createdAt: NOW,
      });
      expect(result.outcome).toBe("registered");
    } finally {
      await store.quit();
    }
  });

  redisTest("reports the completion inline for a COMPLETED waitpoint", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.complete({ waitpointId: "w_a", completion: completion() });

      const result = await store.registerOrReport({
        blockId: BLOCK_ID,
        waitpointId: "w_a",
        runId: "run_1",
        createdAt: NOW,
      });

      expect(result.outcome).toBe("completed");
      if (result.outcome !== "completed") throw new Error("unreachable");
      expect(result.completion?.output).toEqual({ inline: '{"ok":true}' });
    } finally {
      await store.quit();
    }
  });

  redisTest("throws for a waitpoint that does not exist", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await expect(
        store.registerOrReport({
          blockId: BLOCK_ID,
          waitpointId: "w_missing",
          runId: "run_1",
          createdAt: NOW,
        })
      ).rejects.toThrow(WaitpointNotFoundError);
    } finally {
      await store.quit();
    }
  });

  redisTest("keeps one watcher entry per batch index", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.registerOrReport({
        blockId: BLOCK_ID,
        waitpointId: "w_a",
        runId: "run_1",
        batchIndex: 0,
        createdAt: NOW,
      });
      await store.registerOrReport({
        blockId: BLOCK_ID,
        waitpointId: "w_a",
        runId: "run_1",
        batchIndex: 2,
        createdAt: NOW,
      });

      await store.complete({ waitpointId: "w_a", completion: completion() });
      const watchers = await queuedWatchers(store, "w_a");
      expect(watchers).toHaveLength(2);
      expect(watchers.map((w) => w.batchIndex).sort((a, b) => a! - b!)).toEqual([0, 2]);
    } finally {
      await store.quit();
    }
  });

  redisTest("carries spanIdToComplete through to the watcher entry", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.registerOrReport({
        blockId: BLOCK_ID,
        waitpointId: "w_a",
        runId: "run_1",
        spanIdToComplete: "span_abc",
        createdAt: NOW,
      });

      await store.complete({ waitpointId: "w_a", completion: completion() });
      const watchers = await queuedWatchers(store, "w_a");
      expect(watchers[0]!.spanIdToComplete).toBe("span_abc");
      expect(watchers[0]!.runId).toBe("run_1");
      expect(watchers[0]!.blockId).toBe(BLOCK_ID);
      expect(watchers[0]!.createdAt).toBe(NOW);
    } finally {
      await store.quit();
    }
  });

  redisTest("keeps the first registration's watcher on a re-register", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.registerOrReport({
        blockId: BLOCK_ID,
        waitpointId: "w_a",
        runId: "run_1",
        spanIdToComplete: "span_first",
        createdAt: NOW,
      });
      // Same run, same (absent) batch index, so the watcher field collides. HSETNX must
      // not let this second registration overwrite the first one's span.
      await store.registerOrReport({
        blockId: BLOCK_ID,
        waitpointId: "w_a",
        runId: "run_1",
        spanIdToComplete: "span_second",
        createdAt: NOW,
      });

      await store.complete({ waitpointId: "w_a", completion: completion() });
      const watchers = await queuedWatchers(store, "w_a");
      expect(watchers).toHaveLength(1);
      expect(watchers[0]!.spanIdToComplete).toBe("span_first");
    } finally {
      await store.quit();
    }
  });
});

describe("complete", () => {
  redisTest(
    "flips PENDING to COMPLETED and records fanout without reading the watchers",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
        await store.registerOrReport({
          blockId: BLOCK_ID,
          waitpointId: "w_a",
          runId: "run_1",
          createdAt: NOW,
        });
        await store.registerOrReport({
          blockId: BLOCK_ID,
          waitpointId: "w_a",
          runId: "run_2",
          createdAt: NOW,
        });

        const result = await store.complete({ waitpointId: "w_a", completion: completion() });

        expect(result.outcome).toBe("completed");
        expect(result.fanout).toBe("pending");
        // The watchers are still owed a delivery, and reading them is now the worker's job.
        expect((await queuedWatchers(store, "w_a")).map((w) => w.runId).sort()).toEqual([
          "run_1",
          "run_2",
        ]);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "an equivalent repeat is idempotent success and does not recreate the fanout",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
        await store.registerOrReport({
          blockId: BLOCK_ID,
          waitpointId: "w_a",
          runId: "run_1",
          createdAt: NOW,
        });

        // A different completedAt, the same semantic completion: the fingerprint excludes
        // the timestamp precisely so an ordinary retry is not read as a conflict.
        const first = await store.complete({ waitpointId: "w_a", completion: completion() });
        const second = await store.complete({
          waitpointId: "w_a",
          completion: completion({ completedAt: "2026-08-21T13:00:00.000Z" }),
        });

        expect(first.outcome).toBe("completed");
        expect(second.outcome).toBe("already");
        // The FIRST completion wins, matching the guard on status = PENDING.
        expect(second.completion?.completedAt).toBe(NOW);
        expect(second.fanout).toBe("pending");
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "a second, non-equivalent completion fails loudly and changes nothing",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
        await store.complete({ waitpointId: "w_a", completion: completion() });

        await expect(
          store.complete({
            waitpointId: "w_a",
            completion: completion({ output: { inline: '{"second":true}' } }),
          })
        ).rejects.toThrow(WaitpointCompletionConflictError);

        const stored = await store.createIfAbsent({
          record: record("w_a"),
          status: "PENDING",
        });
        expect(stored.outcome).toBe("exists");
        expect(stored.outcome === "exists" && stored.completion?.output).toEqual({
          inline: '{"ok":true}',
        });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("throws for a waitpoint that does not exist", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await expect(
        store.complete({ waitpointId: "w_missing", completion: completion() })
      ).rejects.toThrow(WaitpointNotFoundError);
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "owes no fanout and is terminal at once when nobody is blocked",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
        const result = await store.complete({ waitpointId: "w_a", completion: completion() });

        expect(result.fanout).toBe("absent");
        // No watcher can register after the flip, so every lifecycle obligation is already
        // discharged and the terminal window is armed immediately.
        expect(await probe.pttl("wp:v1:{w_a}")).toBeGreaterThan(0);
        expect(await probe.exists("wp:v1:{w_a}:f")).toBe(0);
        expect(await store.dueFanoutEntries({ partition: 0, limit: 100, now: Date.now() })).toEqual(
          []
        );
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "decodes an absent completion field on an already-completed record without disturbing its watchers",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        // registerOrReport never lets a watcher land once status is COMPLETED, so this
        // shape is forced by hand: it pins that an absent 'c' field decodes to an
        // undefined completion without disturbing the watchers that follow it in the
        // reply array.
        await store.createIfAbsent({ record: record("w_a"), status: "COMPLETED" });
        const watcher: WatcherEntry = { runId: "run_1", blockId: BLOCK_ID, createdAt: NOW };
        await probe.hset("wp:v1:{w_a}:w", watcherField("run_1", BLOCK_ID), JSON.stringify(watcher));

        const result = await store.complete({ waitpointId: "w_a", completion: completion() });

        expect(result.outcome).toBe("already");
        expect(result.completion).toBeUndefined();
        // A record with no stored completion id cannot be compared, so an incoming one is
        // idempotent success rather than a conflict.
        expect(result.fanout).toBe("absent");
        expect(await probe.hget("wp:v1:{w_a}:w", watcherField("run_1", BLOCK_ID))).not.toBeNull();
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest("sets no TTL on the record or the watcher key", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.registerOrReport({
        blockId: BLOCK_ID,
        waitpointId: "w_a",
        runId: "run_1",
        createdAt: NOW,
      });
      await store.complete({ waitpointId: "w_a", completion: completion() });

      // -1 means the key exists with no expiry. Anything >= 0 breaks the retention rule.
      expect(await probe.pttl("wp:v1:{w_a}")).toBe(-1);
      expect(await probe.pttl("wp:v1:{w_a}:w")).toBe(-1);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });
});

// A coordinator method now drives each of these scripts, but this block stays: it is the
// only place asserting the RAW reply shape, so a Lua/TypeScript framing change made on
// both sides at once would still fail here even though every class-level test passed.
describe("reply framing (direct Lua — pins the wire shape the coordinator decodes)", () => {
  const envelope = JSON.stringify(completion());

  redisTest(
    "does not double-count a waitpoint reported pending then delivered in the same batch",
    async ({ redisOptions }) => {
      const client = createRedisClient(redisOptions);
      registerWaitpointCommands(client);
      try {
        const keys = runBlockKeys("run_1");
        const fieldA = edgeField("w_solo", 0);
        const fieldB = edgeField("w_solo", 1);

        // Group 0 arrives unreported (still pending); group 1 for the SAME waitpoint
        // arrives already reported. This is the straddle that broke pendingOfRequested.
        const reply = await client.runAbsorbBlockers(
          keys.pend,
          keys.done,
          keys.edge,
          keys.state,
          BLOCK_ID,
          "0",
          "",
          "2",
          "w_solo",
          fieldA,
          "{}",
          "0",
          "",
          "w_solo",
          fieldB,
          "{}",
          "1",
          envelope
        );

        // Slots 2 and 3 are the superseded block id and its edge-field count, both empty here
        // because no previous block was replaced; the delivered pairs follow them.
        expect(reply).toEqual(["absorbed", "0", "0", "", "0", "w_solo", envelope]);
        expect(await client.scard(keys.pend)).toBe(0);
      } finally {
        client.disconnect();
      }
    }
  );

  redisTest(
    "produces the identical result when the same two groups arrive in reverse order",
    async ({ redisOptions }) => {
      const client = createRedisClient(redisOptions);
      registerWaitpointCommands(client);
      try {
        const keys = runBlockKeys("run_1");
        const fieldA = edgeField("w_solo", 0);
        const fieldB = edgeField("w_solo", 1);

        const reply = await client.runAbsorbBlockers(
          keys.pend,
          keys.done,
          keys.edge,
          keys.state,
          BLOCK_ID,
          "0",
          "",
          "2",
          "w_solo",
          fieldB,
          "{}",
          "1",
          envelope,
          "w_solo",
          fieldA,
          "{}",
          "0",
          ""
        );

        // Slots 2 and 3 are the superseded block id and its edge-field count, both empty here
        // because no previous block was replaced; the delivered pairs follow them.
        expect(reply).toEqual(["absorbed", "0", "0", "", "0", "w_solo", envelope]);
        expect(await client.scard(keys.pend)).toBe(0);
      } finally {
        client.disconnect();
      }
    }
  );

  redisTest("counts two distinct unreported ids as fully pending", async ({ redisOptions }) => {
    const client = createRedisClient(redisOptions);
    registerWaitpointCommands(client);
    try {
      const keys = runBlockKeys("run_1");

      const reply = await client.runAbsorbBlockers(
        keys.pend,
        keys.done,
        keys.edge,
        keys.state,
        BLOCK_ID,
        "0",
        "",
        "2",
        "w_a",
        edgeField("w_a", 0),
        "{}",
        "0",
        "",
        "w_b",
        edgeField("w_b", 0),
        "{}",
        "0",
        ""
      );

      expect(reply).toEqual(["absorbed", "2", "2", "", "0"]);
      expect(await client.scard(keys.pend)).toBe(2);
    } finally {
      client.disconnect();
    }
  });

  redisTest(
    "counts one reported and one unreported id as one pending, one delivered",
    async ({ redisOptions }) => {
      const client = createRedisClient(redisOptions);
      registerWaitpointCommands(client);
      try {
        const keys = runBlockKeys("run_1");

        const reply = await client.runAbsorbBlockers(
          keys.pend,
          keys.done,
          keys.edge,
          keys.state,
          BLOCK_ID,
          "0",
          "",
          "2",
          "w_a",
          edgeField("w_a", 0),
          "{}",
          "0",
          "",
          "w_b",
          edgeField("w_b", 0),
          "{}",
          "1",
          envelope
        );

        expect(reply).toEqual(["absorbed", "1", "1", "", "0", "w_b", envelope]);
        expect(await client.scard(keys.pend)).toBe(1);
      } finally {
        client.disconnect();
      }
    }
  );

  redisTest(
    "reported flag '1' with an empty envelope still delivers, not pends",
    async ({ redisOptions }) => {
      const client = createRedisClient(redisOptions);
      registerWaitpointCommands(client);
      try {
        const keys = runBlockKeys("run_1");

        // The bug this task fixed: COMPLETED-with-no-envelope must take the reported
        // branch on the flag alone, not on the envelope being non-empty.
        const reply = await client.runAbsorbBlockers(
          keys.pend,
          keys.done,
          keys.edge,
          keys.state,
          BLOCK_ID,
          "0",
          "",
          "1",
          "w_a",
          edgeField("w_a", 0),
          "{}",
          "1",
          ""
        );

        expect(reply).toEqual(["absorbed", "0", "0", "", "0", "w_a", ""]);
        expect(await client.scard(keys.pend)).toBe(0);
      } finally {
        client.disconnect();
      }
    }
  );

  redisTest(
    "counts the same unreported id passed twice as one pending, not two",
    async ({ redisOptions }) => {
      const client = createRedisClient(redisOptions);
      registerWaitpointCommands(client);
      try {
        const keys = runBlockKeys("run_1");

        const reply = await client.runAbsorbBlockers(
          keys.pend,
          keys.done,
          keys.edge,
          keys.state,
          BLOCK_ID,
          "0",
          "",
          "2",
          "w_a",
          edgeField("w_a", 0),
          "{}",
          "0",
          "",
          "w_a",
          edgeField("w_a", 1),
          "{}",
          "0",
          ""
        );

        expect(reply).toEqual(["absorbed", "1", "1", "", "0"]);
        expect(await client.scard(keys.pend)).toBe(1);
      } finally {
        client.disconnect();
      }
    }
  );

  redisTest(
    "counts an id already in done, passed unreported, as delivered rather than pending",
    async ({ redisOptions }) => {
      const client = createRedisClient(redisOptions);
      registerWaitpointCommands(client);
      try {
        const keys = runBlockKeys("run_1");
        // A completion that landed between register and absorb — the delivered set
        // already has this id before the absorb call ever sees it.
        await client.hset(keys.done, "w_a", envelope);

        const reply = await client.runAbsorbBlockers(
          keys.pend,
          keys.done,
          keys.edge,
          keys.state,
          BLOCK_ID,
          "0",
          "",
          "1",
          "w_a",
          edgeField("w_a", 0),
          "{}",
          "0",
          ""
        );

        expect(reply).toEqual(["absorbed", "0", "0", "", "0", "w_a", envelope]);
        expect(await client.scard(keys.pend)).toBe(0);
      } finally {
        client.disconnect();
      }
    }
  );

  redisTest("rejects an arity mismatch before writing anything", async ({ redisOptions }) => {
    const client = createRedisClient(redisOptions);
    registerWaitpointCommands(client);
    try {
      const keys = runBlockKeys("run_1");
      const field = edgeField("w_solo", 0);

      // n says 2 groups (1 + 2 * 5 = 11 ARGV entries expected) but only one group (5
      // ARGV entries) is supplied.
      await expect(
        client.runAbsorbBlockers(
          keys.pend,
          keys.done,
          keys.edge,
          keys.state,
          BLOCK_ID,
          "0",
          "",
          "2",
          "w_solo",
          field,
          "{}",
          "0",
          ""
        )
      ).rejects.toThrow();

      expect(await client.exists(keys.pend)).toBe(0);
      expect(await client.exists(keys.done)).toBe(0);
      expect(await client.exists(keys.edge)).toBe(0);
    } finally {
      client.disconnect();
    }
  });

  redisTest(
    "runClear rejects an arity mismatch before writing anything",
    async ({ redisOptions }) => {
      const client = createRedisClient(redisOptions);
      registerWaitpointCommands(client);
      try {
        const keys = runBlockKeys("run_1");
        const field = edgeField("w_solo", 0);
        await client.hset(keys.edge, field, "{}");
        await client.sadd(keys.pend, "w_solo");

        // n says 2 fields but only one field is supplied.
        await expect(
          client.runClear(keys.pend, keys.done, keys.edge, keys.state, "2", field)
        ).rejects.toThrow();

        expect(await client.hexists(keys.edge, field)).toBe(1);
        expect(await client.sismember(keys.pend, "w_solo")).toBe(1);
      } finally {
        client.disconnect();
      }
    }
  );

  redisTest(
    "wpIdemReserve rejects a non-numeric expiry and does not create the reservation",
    async ({ redisOptions }) => {
      const client = createRedisClient(redisOptions);
      registerWaitpointCommands(client);
      try {
        const key = idempotencyKey(ENV_ID, "key-1");

        await expect(client.wpIdemReserve(key, "w_a", "not-a-number")).rejects.toThrow();

        expect(await client.exists(key)).toBe(0);
      } finally {
        client.disconnect();
      }
    }
  );
});

describe("createWithIdempotencyKey", () => {
  // Real minted ids. The method rejects anything but a standalone DATETIME/MANUAL id, because
  // its loser-discard is only safe for an id that was never handed out.
  const idA = generateWaitpointId("MANUAL");
  const idB = generateWaitpointId("MANUAL");
  redisTest("creates the waitpoint and wins the reservation", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const result = await store.createWithIdempotencyKey({
        record: record(idA, { idempotencyKey: "key-1", userProvidedIdempotencyKey: true }),
        environmentId: ENV_ID,
        idempotencyKey: "key-1",
      });

      expect(result).toEqual({ waitpointId: idA, created: true });
    } finally {
      await store.quit();
    }
  });

  redisTest("returns the winner's id and deletes the loser", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await store.createWithIdempotencyKey({
        record: record(idA, { idempotencyKey: "key-1", userProvidedIdempotencyKey: true }),
        environmentId: ENV_ID,
        idempotencyKey: "key-1",
      });

      const second = await store.createWithIdempotencyKey({
        record: record(idB, { idempotencyKey: "key-1", userProvidedIdempotencyKey: true }),
        environmentId: ENV_ID,
        idempotencyKey: "key-1",
      });

      expect(second).toEqual({ waitpointId: idA, created: false });
      // The loser cleans up after itself: nothing ever referenced its id.
      expect(await probe.exists(`wp:v1:{${idB}}`)).toBe(0);
      expect(await probe.exists(`wp:v1:{${idA}}`)).toBe(1);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest(
    "the original creator's own retry does not discard its own record",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        const withKey = record(idA, {
          idempotencyKey: "key-1",
          userProvidedIdempotencyKey: true,
        });

        const first = await store.createWithIdempotencyKey({
          record: withKey,
          environmentId: ENV_ID,
          idempotencyKey: "key-1",
        });
        expect(first).toEqual({ waitpointId: idA, created: true });

        // The SAME caller, retrying with the SAME record id and the SAME key — not a
        // different id racing for the same reservation.
        const retry = await store.createWithIdempotencyKey({
          record: withKey,
          environmentId: ENV_ID,
          idempotencyKey: "key-1",
        });

        expect(retry).toEqual({ waitpointId: idA, created: false });
        // The record must survive: a wrongly-discarded record would delete this too.
        expect(await probe.exists(`wp:v1:{${idA}}`)).toBe(1);

        // The real proof: something usable is still there for every later caller that
        // blocks on this id.
        const registered = await store.registerOrReport({
          blockId: BLOCK_ID,
          waitpointId: idA,
          runId: "run_1",
          createdAt: NOW,
        });
        expect(registered.outcome).toBe("registered");
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest("sets no expiry when the record carries none", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await store.createWithIdempotencyKey({
        record: record(idA, { idempotencyKey: "key-1", userProvidedIdempotencyKey: true }),
        environmentId: ENV_ID,
        idempotencyKey: "key-1",
      });

      // The common case. An expiry appearing here would be a retention rule violation.
      expect(await probe.pttl(`wp:v1:idem:{${ENV_ID}}:key-1`)).toBe(-1);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("sets the expiry the record carries", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await store.createWithIdempotencyKey({
        record: record(idA, {
          idempotencyKey: "key-1",
          userProvidedIdempotencyKey: true,
          idempotencyKeyExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        environmentId: ENV_ID,
        idempotencyKey: "key-1",
      });

      const ttl = await probe.pttl(`wp:v1:idem:{${ENV_ID}}:key-1`);
      // Wide band, deliberately: the deadline is computed from the test process's clock
      // and applied as an absolute PEXPIREAT, while PTTL is computed against the Redis
      // server's own clock. A few ms of disagreement between those two clocks is normal
      // and shows up as overshoot on this read, not as a bug in the reservation. The
      // band still catches every failure worth catching — wrong units, no expiry
      // applied, a negative TTL — without re-asserting that two independent clocks
      // agree to the millisecond.
      expect(ttl).toBeGreaterThan(55_000);
      expect(ttl).toBeLessThanOrEqual(65_000);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("scopes reservations by environment", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createWithIdempotencyKey({
        record: record(idA, { idempotencyKey: "key-1" }),
        environmentId: "env_1",
        idempotencyKey: "key-1",
      });

      const other = await store.createWithIdempotencyKey({
        record: record(idB, { idempotencyKey: "key-1", environmentId: "env_2" }),
        environmentId: "env_2",
        idempotencyKey: "key-1",
      });

      expect(other).toEqual({ waitpointId: idB, created: true });
    } finally {
      await store.quit();
    }
  });
});

redisTest(
  "rejects a derived RUN id, whose loser-discard would be unsafe",
  async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      // A derived id is recomputable from its anchor, so another caller can register a
      // watcher on it. Discarding one could delete a record already in use.
      const derived = deriveWaitpointIdFromAnchor(`run_${generateRunOpsId()}`, "RUN")!;
      await expect(
        store.createWithIdempotencyKey({
          record: record(derived, { type: "RUN", idempotencyKey: "key-1" }),
          environmentId: ENV_ID,
          idempotencyKey: "key-1",
        })
      ).rejects.toThrow(/freshly minted DATETIME or MANUAL/);
    } finally {
      await store.quit();
    }
  }
);

describe("the single-slot guard", () => {
  redisTest("rejects an invocation whose keys span two tags", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      // Reaches the same wrapper every operation goes through, so this proves the guard
      // is live at the call path and not only in the pure unit test.
      expect(() =>
        store.assertKeysForTest("wpComplete", ["wp:v1:{w_a}", "wp:v1:run:{run_1}:pend"])
      ).toThrow(WaitpointKeyTagError);
    } finally {
      await store.quit();
    }
  });
});

const RUN_ID = "run_1";

function edge(waitpointId: string, overrides: Partial<BlockEdge> = {}): BlockEdge {
  return { waitpointId, createdAt: NOW, type: "MANUAL", ...overrides };
}

describe("absorbBlockers", () => {
  redisTest("counts pending blockers and reports the store total", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const result = await store.absorbBlockers({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        edges: [edge("w_a"), edge("w_b")],
      });

      expect(result.pendingOfRequested).toBe(2);
      expect(result.storePendingTotal).toBe(2);
      expect(result.alreadyDelivered).toEqual([]);
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "counts a repeated waitpoint id once, matching a count over distinct rows",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        const result = await store.absorbBlockers({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          edges: [edge("w_a", { batchIndex: 0 }), edge("w_a", { batchIndex: 2 })],
        });

        // The count this replaces was a COUNT(*) over waitpoint rows, so two edges for
        // one waitpoint contributed one. Both numbers must say 1, not 2.
        expect(result.pendingOfRequested).toBe(1);
        expect(result.storePendingTotal).toBe(1);

        const state = await store.readBlockState(RUN_ID);
        expect(state.edges).toHaveLength(2);
        expect(state.edges.map((e) => e.batchIndex).sort()).toEqual([0, 2]);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "does not add a reported-complete blocker to the pending set",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        const result = await store.absorbBlockers({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          edges: [edge("w_a", { reported: { completion: completion() } }), edge("w_b")],
        });

        expect(result.pendingOfRequested).toBe(1);
        expect(result.storePendingTotal).toBe(1);
        expect(result.alreadyDelivered.map((d) => d.waitpointId)).toEqual(["w_a"]);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "a later absorb reads back the stored envelope, not a bare flag",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        const envelope = completion({ output: { inline: '{"first":true}' } });

        // Reported once, with an envelope — this write is what's under test.
        await store.absorbBlockers({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          edges: [edge("w_a", { reported: { completion: envelope } })],
        });

        // Same waitpoint id, arriving unreported this time: takes the "read `done` back"
        // path, exposing whatever the first call actually stored under that id.
        const second = await store.absorbBlockers({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          edges: [edge("w_a")],
        });

        expect(second.alreadyDelivered).toHaveLength(1);
        expect(second.alreadyDelivered[0]!.completion).toEqual(envelope);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "a later absorb for a no-envelope delivery reads back no completion",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.absorbBlockers({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          edges: [edge("w_a", { reported: {} })],
        });

        const second = await store.absorbBlockers({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          edges: [edge("w_a")],
        });

        expect(second.alreadyDelivered).toHaveLength(1);
        expect(second.alreadyDelivered[0]!.completion).toBeUndefined();
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("reports a repeated already-delivered id once", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const result = await store.absorbBlockers({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        edges: [
          edge("w_a", { batchIndex: 0, reported: { completion: completion() } }),
          edge("w_a", { batchIndex: 1, reported: { completion: completion() } }),
        ],
      });

      expect(result.alreadyDelivered).toHaveLength(1);
    } finally {
      await store.quit();
    }
  });

  redisTest("lets a delivery that raced ahead of the absorb win", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.deliverCompletion({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        waitpointId: "w_a",
        completion: completion(),
      });

      const result = await store.absorbBlockers({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        edges: [edge("w_a")],
      });

      expect(result.pendingOfRequested).toBe(0);
      expect(result.storePendingTotal).toBe(0);
      expect(result.alreadyDelivered.map((d) => d.waitpointId)).toEqual(["w_a"]);
    } finally {
      await store.quit();
    }
  });

  redisTest("is idempotent when run twice", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const first = await store.absorbBlockers({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        edges: [edge("w_a")],
      });
      const second = await store.absorbBlockers({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        edges: [edge("w_a")],
      });

      expect(first.storePendingTotal).toBe(1);
      expect(second.storePendingTotal).toBe(1);
      expect((await store.readBlockState(RUN_ID)).edges).toHaveLength(1);
    } finally {
      await store.quit();
    }
  });

  redisTest("keeps the first edge's metadata on a retry", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.absorbBlockers({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        edges: [edge("w_a", { spanIdToComplete: "span_first" })],
      });
      await store.absorbBlockers({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        edges: [edge("w_a", { spanIdToComplete: "span_second" })],
      });

      expect((await store.readBlockState(RUN_ID)).edges[0]!.spanIdToComplete).toBe("span_first");
    } finally {
      await store.quit();
    }
  });

  redisTest("reports the run's real total for an empty edge list", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.absorbBlockers({ blockId: BLOCK_ID, runId: RUN_ID, edges: [edge("w_a")] });

      const result = await store.absorbBlockers({ blockId: BLOCK_ID, runId: RUN_ID, edges: [] });

      // pendingOfRequested is 0 because nothing was requested. storePendingTotal is the
      // run's whole store-resident set, which is NOT empty.
      expect(result.pendingOfRequested).toBe(0);
      expect(result.storePendingTotal).toBe(1);
      expect(result.alreadyDelivered).toEqual([]);
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "reports a smaller pendingOfRequested than storePendingTotal when an unrelated blocker is already pending",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        // w_x is a live blocker from an earlier absorb, unrelated to this call's request.
        await store.absorbBlockers({ blockId: BLOCK_ID, runId: RUN_ID, edges: [edge("w_x")] });

        const result = await store.absorbBlockers({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          edges: [edge("w_a", { reported: { completion: completion() } })],
        });

        // Nothing THIS call requested is pending (w_a arrived already delivered), but the
        // run's whole store-resident set still holds w_x — a divergence for a different
        // reason than an empty request list, so a reply[0]/reply[1] swap or a
        // re-derived-in-TypeScript pendingOfRequested would both be caught here too.
        expect(result.pendingOfRequested).toBe(0);
        expect(result.storePendingTotal).toBe(1);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("sets no TTL on any run key", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await store.absorbBlockers({ blockId: BLOCK_ID, runId: RUN_ID, edges: [edge("w_a")] });
      await store.deliverCompletion({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        waitpointId: "w_a",
        completion: completion(),
      });

      // -1 is "exists, no expiry"; -2 is "no key". Neither is a TTL. `pend` is emptied by
      // the delivery, and Redis deletes an empty set, so -2 is expected there.
      for (const key of [
        `wp:v1:run:{${RUN_ID}}:pend`,
        `wp:v1:run:{${RUN_ID}}:done`,
        `wp:v1:run:{${RUN_ID}}:edge`,
      ]) {
        expect(await probe.pttl(key)).toBeLessThan(0);
      }
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });
});

describe("deliverCompletion", () => {
  redisTest("removes the blocker and returns the new store total", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.absorbBlockers({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        edges: [edge("w_a"), edge("w_b")],
      });

      expect(
        (
          await store.deliverCompletion({
            blockId: BLOCK_ID,
            runId: RUN_ID,
            waitpointId: "w_a",
            completion: completion(),
          })
        ).storePendingTotal
      ).toBe(1);

      expect(
        (
          await store.deliverCompletion({
            blockId: BLOCK_ID,
            runId: RUN_ID,
            waitpointId: "w_b",
            completion: completion(),
          })
        ).storePendingTotal
      ).toBe(0);
    } finally {
      await store.quit();
    }
  });

  redisTest("is idempotent", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.absorbBlockers({ blockId: BLOCK_ID, runId: RUN_ID, edges: [edge("w_a")] });
      await store.deliverCompletion({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        waitpointId: "w_a",
        completion: completion(),
      });
      const again = await store.deliverCompletion({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        waitpointId: "w_a",
        completion: completion(),
      });

      expect(again.storePendingTotal).toBe(0);
    } finally {
      await store.quit();
    }
  });
});

describe("readBlockState", () => {
  redisTest(
    "returns the pending ids, the delivered ids and the edges",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.absorbBlockers({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          edges: [
            edge("w_a", { batchIndex: 0, completedAfter: NOW, type: "DATETIME" }),
            edge("w_b"),
          ],
        });
        await store.deliverCompletion({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          waitpointId: "w_a",
          completion: completion(),
        });

        const state = await store.readBlockState(RUN_ID);

        expect(state.pendingIds).toEqual(["w_b"]);
        expect(state.deliveredIds).toEqual(["w_a"]);
        expect(state.edges).toHaveLength(2);

        const datetime = state.edges.find((e) => e.waitpointId === "w_a");
        // type and completedAfter must ride the edge: a frozen return type needs them, and
        // they live on the waitpoint's own shard, which this read cannot touch.
        expect(datetime?.type).toBe("DATETIME");
        expect(datetime?.completedAfter).toBe(NOW);
        expect(datetime?.edgeId).toBe("w_a#0");
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("returns empty collections for a run with no blockers", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      expect(await store.readBlockState("run_unknown")).toEqual({
        pendingIds: [],
        deliveredIds: [],
        edges: [],
        blockId: undefined,
        handoff: "none",
        terminal: false,
      });
    } finally {
      await store.quit();
    }
  });
});

describe("clearBlockState", () => {
  redisTest("drains the named edges and reconciles", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.absorbBlockers({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        edges: [edge("w_a"), edge("w_b")],
      });
      await store.deliverCompletion({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        waitpointId: "w_a",
        completion: completion(),
      });

      expect(
        (await store.clearBlockState({ runId: RUN_ID, blockId: BLOCK_ID, edgeIds: ["w_a#"] }))
          .outcome
      ).toBe("drained");

      const state = await store.readBlockState(RUN_ID);
      expect(state.edges.map((e) => e.waitpointId)).toEqual(["w_b"]);
      expect(state.deliveredIds).toEqual([]);
      expect(state.pendingIds).toEqual(["w_b"]);
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "keeps a waitpoint's delivery while another edge for it survives",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.absorbBlockers({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          edges: [edge("w_a", { batchIndex: 0 }), edge("w_a", { batchIndex: 1 })],
        });
        await store.deliverCompletion({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          waitpointId: "w_a",
          completion: completion(),
        });

        await store.clearBlockState({ runId: RUN_ID, blockId: BLOCK_ID, edgeIds: ["w_a#0"] });

        // One edge remains, so the delivery must remain too — dropping it would make the
        // surviving edge look undelivered.
        const state = await store.readBlockState(RUN_ID);
        expect(state.edges.map((e) => e.edgeId)).toEqual(["w_a#1"]);
        expect(state.deliveredIds).toEqual(["w_a"]);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("reaps a delivered entry that no edge references", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      // The register-before-absorb window: a delivery can land for a waitpoint whose edge
      // was never written. A name-derived drain could never reach it.
      await store.absorbBlockers({ blockId: BLOCK_ID, runId: RUN_ID, edges: [edge("w_kept")] });
      await store.deliverCompletion({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        waitpointId: "w_orphan",
        completion: completion(),
      });

      expect((await store.readBlockState(RUN_ID)).deliveredIds).toEqual(["w_orphan"]);

      await store.clearBlockState({ runId: RUN_ID, blockId: BLOCK_ID, edgeIds: ["w_nothing#"] });

      const state = await store.readBlockState(RUN_ID);
      expect(state.deliveredIds).toEqual([]);
      expect(state.edges.map((e) => e.waitpointId)).toEqual(["w_kept"]);
    } finally {
      await store.quit();
    }
  });

  redisTest("clears everything when no edge ids are given", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.absorbBlockers({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        edges: [edge("w_a"), edge("w_b")],
      });

      expect((await store.clearBlockState({ runId: RUN_ID, blockId: BLOCK_ID })).outcome).toBe(
        "cleared"
      );
      // The full clear takes the block state with it, so the run is indistinguishable from
      // one that never blocked.
      expect(await store.readBlockState(RUN_ID)).toEqual({
        pendingIds: [],
        deliveredIds: [],
        edges: [],
        blockId: undefined,
        handoff: "none",
        terminal: false,
      });
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "is a no-op for an explicitly empty edge id list, unlike an omitted one",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.absorbBlockers({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          edges: [edge("w_a"), edge("w_b")],
        });

        // Omitting edgeIds reaches the Lua's n === 0 branch and clears everything (proven
        // above). A caller-computed EMPTY array must not collapse onto that: it means
        // "nothing to drain", not "clear the run".
        expect(
          (await store.clearBlockState({ runId: RUN_ID, blockId: BLOCK_ID, edgeIds: [] })).outcome
        ).toBe("noop");

        const state = await store.readBlockState(RUN_ID);
        expect(state.edges.map((e) => e.waitpointId).sort()).toEqual(["w_a", "w_b"]);
        expect(state.pendingIds.sort()).toEqual(["w_a", "w_b"]);
      } finally {
        await store.quit();
      }
    }
  );
});

describe("block-cycle rollover", () => {
  const NEXT_BLOCK = "blk_2";

  redisTest(
    "a new cycle carries none of the acknowledged cycle's state",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_old"), status: "PENDING" });
        await store.createIfAbsent({ record: record("w_new"), status: "PENDING" });

        // Cycle one, resumed and acknowledged — but the drain never happened, which is
        // exactly what an interrupted acknowledgement leaves behind.
        await store.registerBlocks({ runId: RUN_ID, blockId: BLOCK_ID, edges: [edge("w_old")] });
        await store.complete({ waitpointId: "w_old", completion: completion() });
        await store.deliverCompletion({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          waitpointId: "w_old",
          completion: completion(),
        });
        expect(
          (await store.acknowledgeResumeHandoff({ runId: RUN_ID, blockId: BLOCK_ID })).outcome
        ).toBe("acknowledged");

        const stranded = await store.readBlockState(RUN_ID);
        expect(stranded.deliveredIds).toEqual(["w_old"]);
        expect(stranded.edges).toHaveLength(1);

        // Cycle two must not inherit any of it. Otherwise the ordered references a resume
        // is built from would include a waitpoint from the previous cycle.
        await store.registerBlocks({
          runId: RUN_ID,
          blockId: NEXT_BLOCK,
          edges: [edge("w_new")],
          expectedPreviousBlockId: BLOCK_ID,
        });

        const state = await store.readBlockState(RUN_ID);
        expect(state.blockId).toBe(NEXT_BLOCK);
        expect(state.handoff).toBe("none");
        expect(state.pendingIds).toEqual(["w_new"]);
        expect(state.deliveredIds).toEqual([]);
        expect(state.edges.map((e) => e.waitpointId)).toEqual(["w_new"]);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "a same-block retry preserves edges, first metadata and receipts",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.absorbBlockers({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          edges: [edge("w_a", { spanIdToComplete: "span_first" }), edge("w_b")],
        });
        await store.deliverCompletion({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          waitpointId: "w_a",
          completion: completion(),
        });

        // The same block id is a retry, not a rollover.
        const retry = await store.absorbBlockers({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          edges: [edge("w_a", { spanIdToComplete: "span_second" }), edge("w_b")],
        });

        expect(retry.pendingOfRequested).toBe(1);
        expect(retry.alreadyDelivered).toEqual([{ waitpointId: "w_a", completion: completion() }]);

        const state = await store.readBlockState(RUN_ID);
        expect(state.deliveredIds).toEqual(["w_a"]);
        expect(state.pendingIds).toEqual(["w_b"]);
        // HSETNX on the edge write: the first attempt's metadata stands.
        expect(state.edges.find((e) => e.waitpointId === "w_a")?.spanIdToComplete).toBe(
          "span_first"
        );
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "a genuine early delivery survives, because no block is installed yet",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        // Through the public API, before any absorb. This is the only shape in which a
        // receipt legitimately predates its cycle, and it is not a rollover: there is no
        // previous block to roll over from.
        const early = await store.deliverCompletion({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          waitpointId: "w_early",
          completion: completion(),
        });
        expect(early.outcome).toBe("delivered");
        expect(early.resumable).toBe(false);

        const absorbed = await store.absorbBlockers({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          edges: [edge("w_early"), edge("w_other")],
        });

        expect(absorbed.pendingOfRequested).toBe(1);
        expect(absorbed.alreadyDelivered).toEqual([
          { waitpointId: "w_early", completion: completion() },
        ]);
        const state = await store.readBlockState(RUN_ID);
        expect(state.deliveredIds).toEqual(["w_early"]);
        expect(state.pendingIds).toEqual(["w_other"]);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "a rollover clears the previous receipt for a waitpoint the new cycle reuses",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });

        // Cycle one blocks on w_a, completes it and takes the receipt.
        await store.registerBlocks({ runId: RUN_ID, blockId: BLOCK_ID, edges: [edge("w_a")] });
        await store.complete({ waitpointId: "w_a", completion: completion() });
        await store.deliverCompletion({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          waitpointId: "w_a",
          completion: completion(),
        });
        expect((await store.readBlockState(RUN_ID)).deliveredIds).toEqual(["w_a"]);

        // Cycle two waits on the SAME waitpoint. The absorb alone must show the previous
        // receipt gone — carrying it would let the run resume on a receipt from a cycle
        // that is over.
        const rolled = await store.absorbBlockers({
          runId: RUN_ID,
          blockId: NEXT_BLOCK,
          expectedPreviousBlockId: BLOCK_ID,
          edges: [edge("w_a")],
        });
        expect(rolled.pendingOfRequested).toBe(1);
        expect(rolled.alreadyDelivered).toEqual([]);
        expect((await store.readBlockState(RUN_ID)).deliveredIds).toEqual([]);

        // It comes back only because registration reports the frozen completion afresh.
        const registered = await store.registerBlocks({
          runId: RUN_ID,
          blockId: NEXT_BLOCK,
          expectedPreviousBlockId: BLOCK_ID,
          edges: [edge("w_a")],
        });
        expect(registered.pendingOfRequested).toBe(0);
        expect(registered.alreadyDelivered).toEqual([
          { waitpointId: "w_a", completion: completion() },
        ]);
        expect((await store.readBlockState(RUN_ID)).deliveredIds).toEqual(["w_a"]);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "a completion between absorb and register is retained and subtracted",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
        await store.createIfAbsent({ record: record("w_race"), status: "PENDING" });

        // Absorb first, per the block sequence, so both ids are pending with no watchers.
        await store.absorbBlockers({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          edges: [edge("w_a"), edge("w_race")],
        });
        // w_race completes in the window before registration reaches it.
        await store.complete({ waitpointId: "w_race", completion: completion() });

        // Registration reports the frozen envelope rather than taking a watcher, and the
        // helper delivers it against the block already installed.
        const registered = await store.registerBlocks({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          edges: [edge("w_a"), edge("w_race")],
        });

        expect(registered.pendingOfRequested).toBe(1);
        expect(registered.storePendingTotal).toBe(1);
        expect(registered.alreadyDelivered).toEqual([
          { waitpointId: "w_race", completion: completion() },
        ]);

        const state = await store.readBlockState(RUN_ID);
        expect(state.deliveredIds).toEqual(["w_race"]);
        expect(state.pendingIds).toEqual(["w_a"]);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "registerBlocks reports the final counts after its own deliveries",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        // Both already complete before the block even starts.
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
        await store.createIfAbsent({ record: record("w_b"), status: "PENDING" });
        await store.complete({ waitpointId: "w_a", completion: completion() });
        await store.complete({ waitpointId: "w_b", completion: completion() });

        const result = await store.registerBlocks({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          edges: [edge("w_a"), edge("w_b")],
        });

        // Absorb saw them as pending; the registrations reported both complete and the
        // deliveries followed. The result must describe the state at the END of that.
        expect(result.pendingOfRequested).toBe(0);
        expect(result.storePendingTotal).toBe(0);
        expect(result.alreadyDelivered.map((d) => d.waitpointId).sort()).toEqual(["w_a", "w_b"]);
        expect((await store.readBlockState(RUN_ID)).pendingIds).toEqual([]);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("two edges on one waitpoint count and deliver once", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.complete({ waitpointId: "w_a", completion: completion() });

      const result = await store.registerBlocks({
        runId: RUN_ID,
        blockId: BLOCK_ID,
        edges: [edge("w_a", { batchIndex: 0 }), edge("w_a", { batchIndex: 1 })],
      });

      expect(result.pendingOfRequested).toBe(0);
      expect(result.alreadyDelivered).toEqual([{ waitpointId: "w_a", completion: completion() }]);
      expect((await store.readBlockState(RUN_ID)).edges).toHaveLength(2);
    } finally {
      await store.quit();
    }
  });
});

describe("the block boundary between absorb and register", () => {
  redisTest(
    "a durable blocked transition can be published between the two halves",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
        await store.createIfAbsent({ record: record("w_b"), status: "PENDING" });

        // Step 2.
        const absorbed = await store.absorbBlockers({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          edges: [edge("w_a"), edge("w_b")],
        });
        expect(absorbed.pendingOfRequested).toBe(2);

        // Step 3 — stands in for publishing the blocked TRES transition. The point of the
        // seam is that this can happen here at all, with the run already committed as
        // blocked and no watcher registered yet.
        const published: string[] = [];
        const publishBlockedTransition = async () => {
          const state = await store.readBlockState(RUN_ID);
          published.push(...state.pendingIds.sort());
        };
        await publishBlockedTransition();
        expect(published).toEqual(["w_a", "w_b"]);

        // Steps 4 and 5, without absorbing again.
        const registered = await store.registerAndDeliver({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          edges: [edge("w_a"), edge("w_b")],
          absorbed,
        });

        expect(registered.pendingOfRequested).toBe(2);
        expect(registered.alreadyDelivered).toEqual([]);
        const state = await store.readBlockState(RUN_ID);
        expect(state.blockId).toBe(BLOCK_ID);
        expect(state.pendingIds.sort()).toEqual(["w_a", "w_b"]);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "a completion published in the gap is reported and delivered by the register half",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
        await store.createIfAbsent({ record: record("w_race"), status: "PENDING" });

        const absorbed = await store.absorbBlockers({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          edges: [edge("w_a"), edge("w_race")],
        });
        // In the window where the caller is publishing its transition.
        await store.complete({ waitpointId: "w_race", completion: completion() });

        const registered = await store.registerAndDeliver({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          edges: [edge("w_a"), edge("w_race")],
          absorbed,
        });

        expect(registered.pendingOfRequested).toBe(1);
        expect(registered.alreadyDelivered).toEqual([
          { waitpointId: "w_race", completion: completion() },
        ]);
        expect((await store.readBlockState(RUN_ID)).pendingIds).toEqual(["w_a"]);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("the register half performs no absorb of its own", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.complete({ waitpointId: "w_a", completion: completion() });

      const absorbed = await store.absorbBlockers({
        runId: RUN_ID,
        blockId: BLOCK_ID,
        edges: [edge("w_a")],
      });
      // An early receipt from the fanout, landing before registration reaches it.
      await store.deliverCompletion({
        runId: RUN_ID,
        blockId: BLOCK_ID,
        waitpointId: "w_a",
        completion: completion(),
      });

      const registered = await store.registerAndDeliver({
        runId: RUN_ID,
        blockId: BLOCK_ID,
        edges: [edge("w_a")],
        absorbed,
      });

      // The receipt is intact and counted.
      expect(registered.pendingOfRequested).toBe(0);
      expect((await store.readBlockState(RUN_ID)).deliveredIds).toEqual(["w_a"]);
      expect((await store.readBlockState(RUN_ID)).handoff).toBe("owed");
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "a partial registration leaves the documented residue, unchanged",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_ok"), status: "PENDING" });

        const absorbed = await store.absorbBlockers({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          edges: [edge("w_ok"), edge("w_missing")],
        });

        await expect(
          store.registerAndDeliver({
            runId: RUN_ID,
            blockId: BLOCK_ID,
            edges: [edge("w_ok"), edge("w_missing")],
            absorbed,
          })
        ).rejects.toThrow(WaitpointNotFoundError);

        // Both ids stay pending and the run stays blocked. Repairing this is deliberately
        // owned elsewhere; this test exists to pin that the behaviour has not drifted.
        const state = await store.readBlockState(RUN_ID);
        expect(state.pendingIds.sort()).toEqual(["w_missing", "w_ok"]);
        expect(state.deliveredIds).toEqual([]);
        // w_ok's watcher landed before the throw. Read straight off the hash: w_ok is still
        // PENDING, so there is no fanout page to claim it through.
        expect(await probe.hget("wp:v1:{w_ok}:w", watcherField(RUN_ID, BLOCK_ID))).not.toBeNull();
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );
});

describe("delivery after the handoff is acknowledged", () => {
  redisTest(
    "a late duplicate does not re-arm the handoff or signal resumability",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.absorbBlockers({ runId: RUN_ID, blockId: BLOCK_ID, edges: [edge("w_a")] });
        const first = await store.deliverCompletion({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          waitpointId: "w_a",
          completion: completion(),
        });
        expect(first.resumable).toBe(true);
        await store.acknowledgeResumeHandoff({ runId: RUN_ID, blockId: BLOCK_ID });
        await store.clearBlockState({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          edgeIds: [edgeField("w_a")],
        });

        // A fanout redelivery arriving after the resume was durably accepted.
        const late = await store.deliverCompletion({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          waitpointId: "w_a",
          completion: completion(),
        });

        expect(late.outcome).toBe("acked");
        expect(late.resumable).toBe(false);
        const state = await store.readBlockState(RUN_ID);
        expect(state.handoff).toBe("acked");
        // And nothing the acknowledgement drained is recreated.
        expect(state.deliveredIds).toEqual([]);
        expect(state.pendingIds).toEqual([]);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "only the fresh delivery that empties the set signals a resume",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.absorbBlockers({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          edges: [edge("w_a"), edge("w_b")],
        });

        const first = await store.deliverCompletion({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          waitpointId: "w_a",
          completion: completion(),
        });
        expect(first).toMatchObject({ outcome: "delivered", resumable: false });

        const last = await store.deliverCompletion({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          waitpointId: "w_b",
          completion: completion(),
        });
        expect(last).toMatchObject({ outcome: "delivered", resumable: true });
        expect((await store.readBlockState(RUN_ID)).handoff).toBe("owed");

        // Delivery is at-least-once, so a redelivery BEFORE the handoff is acknowledged is
        // routine. It must not claim resumability a second time for the same block, or one
        // block yields several resumes.
        for (const waitpointId of ["w_a", "w_b"]) {
          const duplicate = await store.deliverCompletion({
            runId: RUN_ID,
            blockId: BLOCK_ID,
            waitpointId,
            completion: completion(),
          });
          expect(duplicate).toMatchObject({ outcome: "duplicate", resumable: false });
        }
        expect((await store.readBlockState(RUN_ID)).handoff).toBe("owed");
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "an older block's delivery stays stale once a newer block is installed",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.absorbBlockers({ runId: RUN_ID, blockId: BLOCK_ID, edges: [edge("w_old")] });
        await store.absorbBlockers({
          runId: RUN_ID,
          blockId: "blk_2",
          edges: [edge("w_new")],
          expectedPreviousBlockId: BLOCK_ID,
        });

        const stale = await store.deliverCompletion({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          waitpointId: "w_old",
          completion: completion(),
        });

        expect(stale.outcome).toBe("stale");
        expect(stale.currentBlockId).toBe("blk_2");
        expect(stale.resumable).toBe(false);
        const state = await store.readBlockState(RUN_ID);
        expect(state.pendingIds).toEqual(["w_new"]);
        expect(state.deliveredIds).toEqual([]);
      } finally {
        await store.quit();
      }
    }
  );
});

describe("retention on creation", () => {
  redisTest("a record created COMPLETED is terminal immediately", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await store.createIfAbsent({
        record: record("w_env"),
        status: "COMPLETED",
        completion: completion(),
      });
      // The FINISHED-healing shape: completed, no envelope.
      await store.createIfAbsent({ record: record("w_bare"), status: "COMPLETED" });

      for (const id of ["w_env", "w_bare"]) {
        expect(await probe.pttl(`wp:v1:{${id}}`)).toBeGreaterThan(0);
      }
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("a record created PENDING has no TTL", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      expect(await probe.pttl("wp:v1:{w_a}")).toBe(-1);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("a repeated create does not extend an armed window", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "COMPLETED" });
      const armed = await probe.pttl("wp:v1:{w_a}");

      await store.createIfAbsent({ record: record("w_a"), status: "COMPLETED" });
      expect(await probe.pttl("wp:v1:{w_a}")).toBeLessThanOrEqual(armed);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });
});

describe("registerBlocks: a COMPLETED waitpoint with no envelope never blocks (regression)", () => {
  redisTest(
    "created COMPLETED with no envelope: registerBlocks does not block the run",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        // No `completion` at all — the FINISHED-healing shape from Task 4's "can create an
        // already-COMPLETED record with no completion envelope" test.
        await store.createIfAbsent({ record: record("w_a"), status: "COMPLETED" });

        const result = await store.registerBlocks({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          edges: [edge("w_a")],
        });

        expect(result.pendingOfRequested).toBe(0);
        expect(result.storePendingTotal).toBe(0);
        expect(result.alreadyDelivered.map((d) => d.waitpointId)).toEqual(["w_a"]);
        // The whole point: no fabricated envelope, and the delivery is real on the run
        // shard, not just absent from pending.
        expect(result.alreadyDelivered[0]!.completion).toBeUndefined();
        expect((await store.readBlockState(RUN_ID)).deliveredIds).toEqual(["w_a"]);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "created COMPLETED with an envelope: behaves identically with respect to blocking",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({
          record: record("w_a"),
          status: "COMPLETED",
          completion: completion(),
        });

        const result = await store.registerBlocks({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          edges: [edge("w_a")],
        });

        expect(result.pendingOfRequested).toBe(0);
        expect(result.storePendingTotal).toBe(0);
        expect(result.alreadyDelivered.map((d) => d.waitpointId)).toEqual(["w_a"]);
      } finally {
        await store.quit();
      }
    }
  );
});

describe("registerBlocks: the two orderings", () => {
  redisTest("block first, then complete: the run blocks, then wakes", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });

      const blocked = await store.registerBlocks({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        edges: [edge("w_a")],
      });
      expect(blocked.pendingOfRequested).toBe(1);
      expect(blocked.storePendingTotal).toBe(1);

      const completed = await store.complete({ waitpointId: "w_a", completion: completion() });
      expect(completed.fanout).toBe("pending");
      expect((await queuedWatchers(store, "w_a")).map((w) => w.runId)).toEqual([RUN_ID]);

      const delivered = await store.deliverCompletion({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        waitpointId: "w_a",
        completion: completed.completion!,
      });
      expect(delivered.storePendingTotal).toBe(0);
    } finally {
      await store.quit();
    }
  });

  redisTest("complete first, then block: the run never goes pending", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.complete({ waitpointId: "w_a", completion: completion() });

      const result = await store.registerBlocks({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        edges: [edge("w_a")],
      });

      expect(result.pendingOfRequested).toBe(0);
      expect(result.storePendingTotal).toBe(0);
      expect(result.alreadyDelivered.map((d) => d.waitpointId)).toEqual(["w_a"]);

      const state = await store.readBlockState(RUN_ID);
      expect(state.pendingIds).toEqual([]);
      expect(state.deliveredIds).toEqual(["w_a"]);
    } finally {
      await store.quit();
    }
  });

  redisTest("throws when a blocking waitpoint does not exist", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await expect(
        store.registerBlocks({ blockId: BLOCK_ID, runId: RUN_ID, edges: [edge("w_missing")] })
      ).rejects.toThrow(WaitpointNotFoundError);
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "a throw mid-registration leaves the run absorbed and blocked, never resumable",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_ok"), status: "PENDING" });

        await expect(
          store.registerBlocks({
            blockId: BLOCK_ID,
            runId: RUN_ID,
            edges: [edge("w_ok"), edge("w_missing")],
          })
        ).rejects.toThrow(WaitpointNotFoundError);

        // Absorb runs FIRST, so the run is committed as blocked on both ids. That is the
        // residue the block sequence prefers: an orphaned coordination record the
        // authoritative run state can repair, rather than a registration with no run-side
        // state to deliver into.
        const state = await store.readBlockState(RUN_ID);
        expect(state.blockId).toBe(BLOCK_ID);
        expect(state.pendingIds.sort()).toEqual(["w_missing", "w_ok"]);
        expect(state.edges.map((e) => e.waitpointId).sort()).toEqual(["w_missing", "w_ok"]);
        expect(state.deliveredIds).toEqual([]);

        // w_ok's watcher was registered before the throw, so its completion still reaches
        // the run — and the run stays blocked, because w_missing never resolves.
        const completed = await store.complete({ waitpointId: "w_ok", completion: completion() });
        expect((await queuedWatchers(store, "w_ok")).map((w) => w.runId)).toEqual([RUN_ID]);

        const delivered = await store.deliverCompletion({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          waitpointId: "w_ok",
          completion: completed.completion!,
        });
        expect(delivered.storePendingTotal).toBe(1);
        expect(delivered.resumable).toBe(false);
        expect((await store.readBlockState(RUN_ID)).pendingIds).toEqual(["w_missing"]);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("is idempotent when run twice", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });

      const first = await store.registerBlocks({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        edges: [edge("w_a")],
      });
      const second = await store.registerBlocks({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        edges: [edge("w_a")],
      });

      expect(first.storePendingTotal).toBe(1);
      expect(second.storePendingTotal).toBe(1);
      expect((await store.readBlockState(RUN_ID)).edges).toHaveLength(1);
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "mixed set: one pending and one already complete blocks the run once",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_pending"), status: "PENDING" });
        await store.createIfAbsent({ record: record("w_done"), status: "PENDING" });
        await store.complete({ waitpointId: "w_done", completion: completion() });

        const result = await store.registerBlocks({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          edges: [edge("w_pending"), edge("w_done")],
        });

        expect(result.pendingOfRequested).toBe(1);
        expect(result.storePendingTotal).toBe(1);
        expect(result.alreadyDelivered.map((d) => d.waitpointId)).toEqual(["w_done"]);
      } finally {
        await store.quit();
      }
    }
  );
});

describe("multi-index merge, end to end into the executor shape", () => {
  redisTest(
    "a run blocked on one waitpoint at two indexes resolves to two entries",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({
          record: record("w_child", { type: "RUN", completedByTaskRunId: "run_child" }),
          status: "PENDING",
        });

        await store.registerBlocks({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          edges: [
            edge("w_child", { batchIndex: 0, batchId: "batch_1", type: "RUN" }),
            edge("w_child", { batchIndex: 2, batchId: "batch_1", type: "RUN" }),
          ],
        });

        const completed = await store.complete({
          waitpointId: "w_child",
          completion: completion({ output: null }),
        });
        // The cross-shard fact this test claims to prove: two registers for the same
        // waitpoint at different indexes fanned out into two distinct watcher entries.
        expect(
          (await queuedWatchers(store, "w_child"))
            .map((w) => w.batchIndex)
            .sort((a, b) => (a ?? 0) - (b ?? 0))
        ).toEqual([0, 2]);
        await store.deliverCompletion({
          blockId: BLOCK_ID,
          runId: RUN_ID,
          waitpointId: "w_child",
          completion: completed.completion!,
        });

        const state = await store.readBlockState(RUN_ID);
        expect(state.pendingIds).toEqual([]);
        expect(state.deliveredIds).toEqual(["w_child"]);

        // Derive the cycle's ordered id list the way the read path does: keep only edges
        // that carry a batch index, sort ascending, map to id. Derived inline on purpose —
        // another lane owns the order rule and its resolver, and this test's job is to
        // prove the COORDINATOR preserved the edge multiplicity across two shards, not to
        // own that rule.
        const order = state.edges
          .filter((e) => e.batchIndex !== undefined && e.batchIndex !== null)
          .sort((a, b) => a.batchIndex! - b.batchIndex!)
          .map((e) => e.waitpointId);

        // One waitpoint, two edges, so the id repeats — that repeat is what expands into
        // two entries for the executor, and losing it would silently drop a batch item.
        expect(order).toEqual(["w_child", "w_child"]);
        expect(state.edges.map((e) => e.edgeId).sort()).toEqual(["w_child#0", "w_child#2"]);
        expect(state.edges.every((e) => e.batchId === "batch_1")).toBe(true);
      } finally {
        await store.quit();
      }
    }
  );
});

describe("the resume cycle drains and can start again", () => {
  redisTest("a second wait on the same waitpoint blocks nothing", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.registerBlocks({ blockId: BLOCK_ID, runId: RUN_ID, edges: [edge("w_a")] });

      const completed = await store.complete({ waitpointId: "w_a", completion: completion() });
      await store.deliverCompletion({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        waitpointId: "w_a",
        completion: completed.completion!,
      });

      const first = await store.readBlockState(RUN_ID);
      await store.clearBlockState({
        runId: RUN_ID,
        blockId: BLOCK_ID,
        edgeIds: first.edges.map((e) => e.edgeId),
      });

      // Cycle two. The waitpoint is COMPLETED for good, so the register reports it and the
      // run is never blocked.
      const second = await store.registerBlocks({
        blockId: BLOCK_ID,
        runId: RUN_ID,
        edges: [edge("w_a", { batchIndex: 5 })],
      });

      expect(second.storePendingTotal).toBe(0);
      expect(second.alreadyDelivered.map((d) => d.waitpointId)).toEqual(["w_a"]);
      expect((await store.readBlockState(RUN_ID)).edges.map((e) => e.edgeId)).toEqual(["w_a#5"]);
    } finally {
      await store.quit();
    }
  });
});

// Every test above is a sequence of awaits. Redis guarantees atomicity WITHIN a script, so
// those tests can only ever prove single-script invariants. These races drive real
// concurrent calls (Promise.all over N copies) against the multi-script TypeScript
// sequences, and assert an invariant that holds regardless of who wins — never a timing.
describe("genuine concurrency", () => {
  const CONCURRENCY = 8;

  redisTest(
    "exactly one of N concurrent completers wins, and every caller sees its completion",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
        await store.registerOrReport({
          blockId: BLOCK_ID,
          waitpointId: "w_a",
          runId: "run_1",
          createdAt: NOW,
        });
        await store.registerOrReport({
          blockId: BLOCK_ID,
          waitpointId: "w_a",
          runId: "run_2",
          createdAt: NOW,
        });

        // N racers with the SAME semantic completion: each carries its own timestamp, and
        // the fingerprint ignores that, so the losers are idempotent successes rather than
        // conflicts.
        const results = await Promise.all(
          Array.from({ length: CONCURRENCY }, (_, i) =>
            store.complete({
              waitpointId: "w_a",
              completion: completion({
                completedAt: new Date(Date.UTC(2026, 7, 21, 12, 0, i)).toISOString(),
              }),
            })
          )
        );

        const winners = results.filter((r) => r.outcome === "completed");
        const losers = results.filter((r) => r.outcome === "already");
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(CONCURRENCY - 1);

        // Every caller, winner and losers alike, reads back the SAME stored completion.
        const stored = winners[0]!.completion;
        for (const r of results) {
          expect(r.completion).toEqual(stored);
        }

        // Exactly one durable fanout entry, and it still owes both watchers: a race must
        // never truncate or duplicate the work.
        for (const r of results) {
          expect(r.fanout).toBe("pending");
        }
        expect((await queuedWatchers(store, "w_a")).map((w) => w.runId).sort()).toEqual([
          "run_1",
          "run_2",
        ]);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "a pre-existing registration survives N concurrent attempts to re-register its field",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
        await store.registerOrReport({
          blockId: BLOCK_ID,
          waitpointId: "w_a",
          runId: "run_1",
          spanIdToComplete: "span_first",
          createdAt: NOW,
        });

        // Same run, same (absent) batch index as the registration above, so every one of
        // these collides on the exact same watcher field.
        await Promise.all(
          Array.from({ length: CONCURRENCY }, (_, i) =>
            store.registerOrReport({
              blockId: BLOCK_ID,
              waitpointId: "w_a",
              runId: "run_1",
              spanIdToComplete: `span_racer_${i}`,
              createdAt: NOW,
            })
          )
        );

        await store.complete({ waitpointId: "w_a", completion: completion() });
        const forRun1 = (await queuedWatchers(store, "w_a")).filter((w) => w.runId === "run_1");
        expect(forRun1).toHaveLength(1);
        expect(forRun1[0]!.spanIdToComplete).toBe("span_first");
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "exactly one of N concurrent idempotency-keyed creators wins, and every loser cleans up",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        const ids = Array.from({ length: CONCURRENCY }, () => generateWaitpointId("MANUAL"));

        const results = await Promise.all(
          ids.map((id) =>
            store.createWithIdempotencyKey({
              record: record(id, { idempotencyKey: "key-1", userProvidedIdempotencyKey: true }),
              environmentId: ENV_ID,
              idempotencyKey: "key-1",
            })
          )
        );

        const winners = results.filter((r) => r.created);
        expect(winners).toHaveLength(1);

        const winnerId = winners[0]!.waitpointId;
        for (const r of results) {
          expect(r.waitpointId).toBe(winnerId);
        }
        expect(await probe.exists(`wp:v1:{${winnerId}}`)).toBe(1);

        for (const id of ids) {
          if (id === winnerId) continue;
          expect(await probe.exists(`wp:v1:{${id}}`)).toBe(0);
          expect(await probe.exists(`wp:v1:{${id}}:w`)).toBe(0);
        }
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "registerBlocks racing complete never leaves a waitpoint double-booked or the pending count negative",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        for (let i = 0; i < 30; i++) {
          const waitpointId = `w_race_${i}`;
          const runId = `run_race_${i}`;
          await store.createIfAbsent({ record: record(waitpointId), status: "PENDING" });

          // Two edges for the SAME waitpoint: registerBlocks registers them one at a
          // time, so a concurrent complete() has a real window to land between the two
          // registrations — the exact straddle that makes absorbBlockers' per-group
          // reported/unreported split matter, rather than racing a single all-or-nothing
          // group.
          const [blocked] = await Promise.all([
            store.registerBlocks({
              blockId: BLOCK_ID,
              runId,
              edges: [edge(waitpointId, { batchIndex: 0 }), edge(waitpointId, { batchIndex: 1 })],
            }),
            store.complete({ waitpointId, completion: completion() }),
          ]);

          const state = await store.readBlockState(runId);
          const delivered = state.deliveredIds.includes(waitpointId);
          const pending = state.pendingIds.includes(waitpointId);

          expect(delivered && pending).toBe(false);
          expect(blocked.storePendingTotal).toBeGreaterThanOrEqual(0);
          expect(blocked.storePendingTotal).toBeLessThanOrEqual(1);
        }
      } finally {
        await store.quit();
      }
    }
  );
});

/**
 * The coordinator's inline-output ceiling.
 *
 * `complete` copies, serializes and SYNCHRONOUSLY hashes `output.inline` to derive a
 * fingerprint, and the type permits an arbitrarily long string. The ceiling is asserted before
 * any of that work, so an oversized output costs a length comparison rather than a hash of
 * however many megabytes arrived.
 */
describe("inline completion output limits", () => {
  // One byte over, built from single-byte characters so code-unit length equals byte length.
  const oversized = () =>
    completion({ output: { inline: "x".repeat(MAX_INLINE_COMPLETION_OUTPUT_BYTES + 1) } });
  const atLimit = () =>
    completion({ output: { inline: "x".repeat(MAX_INLINE_COMPLETION_OUTPUT_BYTES) } });

  redisTest(
    "complete() rejects an oversized inline output before touching Redis",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });

        await expect(
          store.complete({ waitpointId: "w_a", completion: oversized() })
        ).rejects.toThrow(WaitpointCompletionTooLargeError);

        // Nothing was written: the record is still PENDING, holds no envelope, and no fanout
        // entry was created. That is what "before Redis execution" means here.
        expect(await probe.hget("wp:v1:{w_a}", "status")).toBe("PENDING");
        expect(await probe.hget("wp:v1:{w_a}", "c")).toBeNull();
        expect(await probe.exists("wp:v1:{w_a}:f")).toBe(0);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest("an inline output exactly at the limit is accepted", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      const result = await store.complete({ waitpointId: "w_a", completion: atLimit() });

      expect(result.outcome).toBe("completed");
      expect(result.fanout).toBe("absent");
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "a multi-byte inline output is measured in bytes, not code units",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
        // Half the limit in code units, but 3 bytes each in UTF-8, so over the byte ceiling.
        // A code-unit-only check would wave this through.
        const wide = completion({
          output: { inline: "€".repeat(MAX_INLINE_COMPLETION_OUTPUT_BYTES / 2) },
        });

        await expect(store.complete({ waitpointId: "w_a", completion: wide })).rejects.toThrow(
          WaitpointCompletionTooLargeError
        );
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "a { ref } output is accepted whatever the referenced payload weighs",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
        // The ref names an object-store key. The payload behind it can be gigabytes; none of it
        // is in this process, so the ceiling does not apply and must not be applied.
        const result = await store.complete({
          waitpointId: "w_a",
          completion: completion({ output: { ref: "waitpoint_w_a/token.json" } }),
        });

        expect(result.outcome).toBe("completed");
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("createIfAbsent() rejects an oversized inline output", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await expect(
        store.createIfAbsent({
          record: record("w_a"),
          status: "COMPLETED",
          completion: oversized(),
        })
      ).rejects.toThrow(WaitpointCompletionTooLargeError);

      expect(await probe.exists("wp:v1:{w_a}")).toBe(0);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("deliverCompletion() rejects an oversized inline output", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await expect(
        store.deliverCompletion({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          waitpointId: "w_a",
          completion: oversized(),
        })
      ).rejects.toThrow(WaitpointCompletionTooLargeError);

      expect(await probe.exists(`wp:v1:run:{${RUN_ID}}:done`)).toBe(0);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest(
    "absorbBlockers() rejects an oversized REPORTED completion before serializing the argv",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        // A reported completion rides into absorption as a receipt, so it reaches the same
        // JSON.stringify an inline completion does.
        await expect(
          store.absorbBlockers({
            runId: RUN_ID,
            blockId: BLOCK_ID,
            edges: [edge("w_a", { reported: { completion: oversized() } })],
          })
        ).rejects.toThrow(WaitpointCompletionTooLargeError);

        expect(await probe.exists(`wp:v1:run:{${RUN_ID}}:st`)).toBe(0);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  // The ceiling changes WHICH completions are accepted, and must change nothing about how two
  // accepted ones compare.
  redisTest("duplicate and conflicting semantics are unchanged", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      const big = atLimit();

      expect((await store.complete({ waitpointId: "w_a", completion: big })).outcome).toBe(
        "completed"
      );
      // Same content, different timestamp: still the same completion, still idempotent.
      expect(
        (
          await store.complete({
            waitpointId: "w_a",
            completion: { ...big, completedAt: "2026-08-21T13:00:00.000Z" },
          })
        ).outcome
      ).toBe("already");

      await expect(
        store.complete({
          waitpointId: "w_a",
          completion: completion({ output: { inline: '{"different":true}' } }),
        })
      ).rejects.toThrow(WaitpointCompletionConflictError);
    } finally {
      await store.quit();
    }
  });
});

/**
 * The rest of the envelope. A `{ ref }` exempts the referenced payload, not the reference
 * string, and the type and timestamp fields are structurally unbounded too.
 */
describe("envelope string limits", () => {
  redisTest("rejects an over-long output.ref", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      // 1088 = the 1024-byte S3/R2 object-key limit plus the `s3://`-style prefix.
      await expect(
        store.complete({
          waitpointId: "w_a",
          completion: completion({ output: { ref: `s3://${"k".repeat(1_089)}` } }),
        })
      ).rejects.toThrow(WaitpointCompletionTooLargeError);

      // A ref at the limit is fine.
      const ok = await store.complete({
        waitpointId: "w_a",
        completion: completion({ output: { ref: "k".repeat(1_088) } }),
      });
      expect(ok.outcome).toBe("completed");
    } finally {
      await store.quit();
    }
  });

  redisTest("rejects an over-long outputType and completedAt", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await expect(
        store.complete({
          waitpointId: "w_a",
          completion: completion({ outputType: "a".repeat(256) }),
        })
      ).rejects.toThrow(/outputType/);
      await expect(
        store.complete({
          waitpointId: "w_a",
          completion: completion({ completedAt: "9".repeat(65) }),
        })
      ).rejects.toThrow(/completedAt/);
    } finally {
      await store.quit();
    }
  });

  redisTest("rejects an over-long caller-supplied completionId", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await expect(
        store.complete({
          waitpointId: "w_a",
          completion: completion(),
          completionId: "c".repeat(257),
        })
      ).rejects.toThrow(/completionId/);
    } finally {
      await store.quit();
    }
  });
});

describe("the encoded-completion boundary", () => {
  redisTest("refuses a forged encoded completion", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      // The whole point of the optimized path being non-forgeable: a plain object would carry
      // a payload that never passed the size checks straight into a receipt.
      const forged = { json: JSON.stringify(completion()) } as never;

      await expect(
        store.deliverEncodedCompletion({
          runId: RUN_ID,
          blockId: BLOCK_ID,
          waitpointId: "w_a",
          encoded: forged,
        })
      ).rejects.toThrow(TypeError);

      expect(await probe.exists(`wp:v1:run:{${RUN_ID}}:done`)).toBe(0);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("accepts one produced by the validated encoder", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.absorbBlockers({
        runId: RUN_ID,
        blockId: BLOCK_ID,
        edges: [edge("w_a")],
      });
      const result = await store.deliverEncodedCompletion({
        runId: RUN_ID,
        blockId: BLOCK_ID,
        waitpointId: "w_a",
        encoded: encodeCompletionForDelivery(completion(), "test"),
      });
      expect(result.outcome).toBe("delivered");
    } finally {
      await store.quit();
    }
  });

  redisTest("the encoder itself refuses an oversized completion", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      expect(() =>
        encodeCompletionForDelivery(
          completion({
            output: { inline: "x".repeat(MAX_INLINE_COMPLETION_OUTPUT_BYTES + 1) },
          }),
          "test"
        )
      ).toThrow(WaitpointCompletionTooLargeError);
    } finally {
      await store.quit();
    }
  });
});

/**
 * The construction token, tested through the cast that defeats the type system.
 *
 * `private constructor` is erased at compile time, so before the token a caller could write
 * `new (EncodedWaitpointCompletion as never)(json, bytes)` and get an instance that satisfied
 * `isEncoded()` while having skipped every size check — a validated-looking envelope of any
 * size, straight into a receipt.
 */
describe("EncodedWaitpointCompletion construction", () => {
  it("refuses direct runtime construction without the module token", () => {
    const Forgeable = EncodedWaitpointCompletion as unknown as new (
      ...args: unknown[]
    ) => EncodedWaitpointCompletion;

    // Exactly the shape the factory produces, minus the token.
    expect(() => new Forgeable(JSON.stringify(completion()), 42)).toThrow(TypeError);
    // And with a decoy symbol, since the check is identity and not merely "a symbol".
    expect(
      () => new Forgeable(Symbol("waitpoint.encodedCompletion"), JSON.stringify(completion()), 42)
    ).toThrow(TypeError);
  });

  it("the factory still produces a usable, self-describing value", () => {
    const encoded = encodeCompletionForDelivery(completion(), "test");

    expect(EncodedWaitpointCompletion.isEncoded(encoded)).toBe(true);
    expect(encoded.json).toBe(JSON.stringify(completion()));
    expect(encoded.bytes).toBe(Buffer.byteLength(encoded.json, "utf8"));
  });

  it("rejects a plain object at the brand check", () => {
    expect(EncodedWaitpointCompletion.isEncoded({ json: "{}", bytes: 2 })).toBe(false);
    expect(EncodedWaitpointCompletion.isEncoded(undefined)).toBe(false);
  });
});

/**
 * Rollover no longer strands the superseded cycle's watcher registrations.
 *
 * The run-side edge set is the ONLY record of which waitpoint shards a block registered on, and
 * the rollover deletes it. Capturing it inside the script and withdrawing afterwards is what
 * stops a pending waitpoint keeping a registration nothing can reach.
 */
describe("superseded watcher cleanup on rollover", () => {
  const NEXT = "blk_2";

  redisTest(
    "a pending waitpoint from block 1 loses its watcher when block 2 rolls over",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_old"), status: "PENDING" });
        await store.createIfAbsent({ record: record("w_new"), status: "PENDING" });
        await store.registerBlocks({ runId: RUN_ID, blockId: BLOCK_ID, edges: [edge("w_old")] });
        expect(await probe.hlen("wp:v1:{w_old}:w")).toBe(1);

        const rolled = await store.registerBlocks({
          runId: RUN_ID,
          blockId: NEXT,
          expectedPreviousBlockId: BLOCK_ID,
          edges: [edge("w_new")],
        });

        // w_old stays PENDING forever and holds no stale registration.
        expect(await probe.hlen("wp:v1:{w_old}:w")).toBe(0);
        expect(await probe.hget("wp:v1:{w_old}", "status")).toBe("PENDING");
        expect(rolled.supersededCleanup).toMatchObject({
          blockId: BLOCK_ID,
          withdrawn: 1,
          failed: [],
        });
        // The new block is intact.
        expect(await probe.hlen("wp:v1:{w_new}:w")).toBe(1);
        expect((await store.readBlockState(RUN_ID)).blockId).toBe(NEXT);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "reusing the same waitpoint in block 2 preserves only block 2's watcher",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
        await store.registerBlocks({ runId: RUN_ID, blockId: BLOCK_ID, edges: [edge("w_a")] });
        await store.registerBlocks({
          runId: RUN_ID,
          blockId: NEXT,
          edges: [edge("w_a")],
          expectedPreviousBlockId: BLOCK_ID,
        });

        // Watcher identity carries the block, so withdrawing the superseded one cannot take
        // the new one with it even on the very same shard.
        expect(Object.keys(await probe.hgetall("wp:v1:{w_a}:w"))).toEqual([
          watcherField(RUN_ID, NEXT),
        ]);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest("a same-block retry unregisters nothing", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.registerBlocks({ runId: RUN_ID, blockId: BLOCK_ID, edges: [edge("w_a")] });

      const retry = await store.registerBlocks({
        runId: RUN_ID,
        blockId: BLOCK_ID,
        edges: [edge("w_a")],
      });

      expect(retry.supersededCleanup).toBeUndefined();
      expect(Object.keys(await probe.hgetall("wp:v1:{w_a}:w"))).toEqual([
        watcherField(RUN_ID, BLOCK_ID),
      ]);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("a first block with no predecessor unregisters nothing", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      const first = await store.registerBlocks({
        runId: RUN_ID,
        blockId: BLOCK_ID,
        edges: [edge("w_a")],
      });
      expect(first.supersededCleanup).toBeUndefined();
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "a completion racing the rollover is not lost by the new block",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
        await store.registerBlocks({ runId: RUN_ID, blockId: BLOCK_ID, edges: [edge("w_a")] });

        // The waitpoint completes while block 1 still owns it, then the run rolls over onto a
        // block that blocks on the same waitpoint. The rollover clears block 1's receipt, so
        // block 2's registration is what must report the frozen envelope.
        await store.complete({ waitpointId: "w_a", completion: completion() });
        const rolled = await store.registerBlocks({
          runId: RUN_ID,
          blockId: NEXT,
          expectedPreviousBlockId: BLOCK_ID,
          edges: [edge("w_a")],
        });

        expect(rolled.pendingOfRequested).toBe(0);
        expect(rolled.alreadyDelivered).toEqual([{ waitpointId: "w_a", completion: completion() }]);
        const state = await store.readBlockState(RUN_ID);
        expect(state.blockId).toBe(NEXT);
        expect(state.deliveredIds).toEqual(["w_a"]);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "an unregister failure leaves block 2 installed and reports the residue",
    async ({ redisOptions }) => {
      // A coordinator whose unregister always fails, so the residue path is exercised for
      // real rather than described. Everything else still runs against Redis.
      class FailingUnregister extends WaitpointStoreCoordinator {
        override async unregisterWatcher(): Promise<never> {
          throw new Error("shard unreachable");
        }
      }
      const store = new FailingUnregister({ redisOptions });
      const probe = createRedisClient(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_old"), status: "PENDING" });
        await store.createIfAbsent({ record: record("w_new"), status: "PENDING" });
        await store.registerBlocks({ runId: RUN_ID, blockId: BLOCK_ID, edges: [edge("w_old")] });

        const rolled = await store.registerBlocks({
          runId: RUN_ID,
          blockId: NEXT,
          expectedPreviousBlockId: BLOCK_ID,
          edges: [edge("w_new")],
        });

        // The cleanup failure did NOT roll back or invalidate the new block.
        expect((await store.readBlockState(RUN_ID)).blockId).toBe(NEXT);
        expect(await probe.hlen("wp:v1:{w_new}:w")).toBe(1);
        // And it is reported as residue, naming what reconciliation has to repair.
        expect(rolled.supersededCleanup).toMatchObject({
          blockId: BLOCK_ID,
          withdrawn: 0,
          failed: [{ waitpointId: "w_old", error: "shard unreachable" }],
        });
        // The stale registration is still there — inert, but unreachable from the run side.
        expect(await probe.hlen("wp:v1:{w_old}:w")).toBe(1);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );
});

/**
 * The compare-and-set on block installation.
 *
 * Block ids are random and carry no order, so a delayed retry of block one was
 * indistinguishable from a rollover onto block one: it wiped block two's pending set and
 * reinstated obsolete edges. The caller names the predecessor it expects instead.
 */
describe("block installation compare-and-set", () => {
  const B1 = "blk_1";
  const B2 = "blk_2";

  redisTest("a first block expecting no predecessor is installed", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const first = await store.absorbBlockers({
        runId: RUN_ID,
        blockId: B1,
        edges: [edge("w_a")],
      });
      expect(first.outcome).toBe("absorbed");
      expect((await store.readBlockState(RUN_ID)).blockId).toBe(B1);
    } finally {
      await store.quit();
    }
  });

  redisTest("a first block PRESERVES an early receipt", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.deliverCompletion({
        runId: RUN_ID,
        blockId: B1,
        waitpointId: "w_early",
        completion: completion(),
      });
      const first = await store.absorbBlockers({
        runId: RUN_ID,
        blockId: B1,
        edges: [edge("w_early"), edge("w_other")],
      });

      expect(first.outcome).toBe("absorbed");
      expect(first.alreadyDelivered).toEqual([
        { waitpointId: "w_early", completion: completion() },
      ]);
    } finally {
      await store.quit();
    }
  });

  redisTest("a same-block retry is idempotent whatever it expects", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.absorbBlockers({
        runId: RUN_ID,
        blockId: B1,
        edges: [edge("w_a", { spanIdToComplete: "span_first" })],
      });
      await store.deliverCompletion({
        runId: RUN_ID,
        blockId: B1,
        waitpointId: "w_a",
        completion: completion(),
      });

      // The block id IS the identity, so a retry is recognised without an expectation.
      const retry = await store.absorbBlockers({
        runId: RUN_ID,
        blockId: B1,
        edges: [edge("w_a", { spanIdToComplete: "span_second" })],
      });

      expect(retry.outcome).toBe("absorbed");
      expect(retry.alreadyDelivered).toEqual([{ waitpointId: "w_a", completion: completion() }]);
      const state = await store.readBlockState(RUN_ID);
      expect(state.deliveredIds).toEqual(["w_a"]);
      expect(state.edges.find((e) => e.waitpointId === "w_a")?.spanIdToComplete).toBe("span_first");
    } finally {
      await store.quit();
    }
  });

  redisTest("an ordered rollover naming its predecessor succeeds", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.absorbBlockers({ runId: RUN_ID, blockId: B1, edges: [edge("w_a")] });
      const rolled = await store.absorbBlockers({
        runId: RUN_ID,
        blockId: B2,
        edges: [edge("w_b")],
        expectedPreviousBlockId: B1,
      });

      expect(rolled.outcome).toBe("absorbed");
      const state = await store.readBlockState(RUN_ID);
      expect(state.blockId).toBe(B2);
      expect(state.pendingIds).toEqual(["w_b"]);
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "a DELAYED block-one retry cannot displace block two, and mutates nothing",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await store.absorbBlockers({ runId: RUN_ID, blockId: B1, edges: [edge("w_a")] });
        await store.absorbBlockers({
          runId: RUN_ID,
          blockId: B2,
          edges: [edge("w_b")],
          expectedPreviousBlockId: B1,
        });

        const before = {
          pend: (await probe.smembers(`wp:v1:run:{${RUN_ID}}:pend`)).sort(),
          done: await probe.hgetall(`wp:v1:run:{${RUN_ID}}:done`),
          edge: await probe.hgetall(`wp:v1:run:{${RUN_ID}}:edge`),
          st: await probe.hgetall(`wp:v1:run:{${RUN_ID}}:st`),
        };

        // The replay: block one arriving again, expecting no predecessor as it did first
        // time round. Lexically "blk_1" < "blk_2", so ordering ids would not have saved this.
        const stale = await store.absorbBlockers({
          runId: RUN_ID,
          blockId: B1,
          edges: [edge("w_a")],
        });

        expect(stale.outcome).toBe("stale");
        expect(stale.currentBlockId).toBe(B2);
        // ZERO mutation: pend, done, edge, blk, hs and term are all exactly as they were.
        expect((await probe.smembers(`wp:v1:run:{${RUN_ID}}:pend`)).sort()).toEqual(before.pend);
        expect(await probe.hgetall(`wp:v1:run:{${RUN_ID}}:done`)).toEqual(before.done);
        expect(await probe.hgetall(`wp:v1:run:{${RUN_ID}}:edge`)).toEqual(before.edge);
        expect(await probe.hgetall(`wp:v1:run:{${RUN_ID}}:st`)).toEqual(before.st);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "a stale rollover expecting the WRONG predecessor is refused",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.absorbBlockers({ runId: RUN_ID, blockId: B1, edges: [edge("w_a")] });

        const stale = await store.absorbBlockers({
          runId: RUN_ID,
          blockId: "blk_3",
          edges: [edge("w_c")],
          expectedPreviousBlockId: "blk_never",
        });

        expect(stale.outcome).toBe("stale");
        expect(stale.currentBlockId).toBe(B1);
        expect((await store.readBlockState(RUN_ID)).blockId).toBe(B1);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "two competing rollovers from the same predecessor: one wins, one is stale",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        await store.absorbBlockers({ runId: RUN_ID, blockId: B1, edges: [edge("w_a")] });

        // Both name B1. Each script is atomic on the run's own slot, so they serialise and
        // the loser sees the winner already installed.
        const [a, b] = await Promise.all([
          store.absorbBlockers({
            runId: RUN_ID,
            blockId: "blk_a",
            edges: [edge("w_x")],
            expectedPreviousBlockId: B1,
          }),
          store.absorbBlockers({
            runId: RUN_ID,
            blockId: "blk_b",
            edges: [edge("w_y")],
            expectedPreviousBlockId: B1,
          }),
        ]);

        const outcomes = [a.outcome, b.outcome].sort();
        expect(outcomes).toEqual(["absorbed", "stale"]);
        const winner = a.outcome === "absorbed" ? "blk_a" : "blk_b";
        expect((await store.readBlockState(RUN_ID)).blockId).toBe(winner);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("a refused absorb registers no watchers", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.createIfAbsent({ record: record("w_late"), status: "PENDING" });
      await store.registerBlocks({ runId: RUN_ID, blockId: B1, edges: [edge("w_a")] });

      // registerBlocks must stop at the refusal rather than going on to register: a watcher
      // for a block the store declined to install could never be delivered to.
      const stale = await store.registerBlocks({
        runId: RUN_ID,
        blockId: "blk_late",
        edges: [edge("w_late")],
        expectedPreviousBlockId: "blk_never",
      });

      expect(stale.outcome).toBe("stale");
      expect(await probe.hlen("wp:v1:{w_late}:w")).toBe(0);
      expect(await probe.exists("wp:v1:{w_late}:q")).toBe(0);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });
});

/**
 * Cancellation must fence delivery before withdrawing registrations.
 *
 * Withdrawing first fenced nothing: a fanout page claimed before the withdrawal already holds
 * its watcher data, so deleting the registration cannot stop that delivery. It landed while
 * `term` was unset, emptied `pend` and set `hs='owed'` — a resume published for a run being
 * cancelled. Installing `term` first makes any such delivery refuse as `terminal`.
 */
describe("cancellation fences delivery before withdrawal", () => {
  // A coordinator whose watcher withdrawal is held open, so the window between marking
  // terminal and finishing the cross-shard cleanup is a barrier rather than a race.
  class PausedWithdrawal extends WaitpointStoreCoordinator {
    entered!: Promise<void>;
    #signalEntered!: () => void;
    #held!: Promise<void>;
    #release!: () => void;

    constructor(options: { redisOptions: RedisOptions }) {
      super(options);
      this.entered = new Promise<void>((resolve) => {
        this.#signalEntered = resolve;
      });
      this.#held = new Promise<void>((resolve) => {
        this.#release = resolve;
      });
    }

    release() {
      this.#release();
    }

    override async unregisterWatcher(
      args: Parameters<WaitpointStoreCoordinator["unregisterWatcher"]>[0]
    ) {
      this.#signalEntered();
      await this.#held;
      return super.unregisterWatcher(args);
    }
  }

  for (const reason of ["cancelled", "terminal"] as const) {
    redisTest(
      `a delivery from a page claimed before ${reason} cleanup is refused as terminal`,
      async ({ redisOptions }) => {
        const store = new PausedWithdrawal({ redisOptions });
        const probe = createRedisClient(redisOptions);
        try {
          await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
          await store.registerBlocks({ runId: RUN_ID, blockId: BLOCK_ID, edges: [edge("w_a")] });
          await store.complete({ waitpointId: "w_a", completion: completion() });

          // The page is claimed FIRST, so the worker already holds the watcher payload.
          const claim = await store.claimFanoutPage({
            waitpointId: "w_a",
            workerId: "worker-a",
            pageSize: 10,
            leaseMs: 60_000,
          });
          expect(claim.outcome).toBe("claimed");

          // Cancellation begins and pauses inside the withdrawal, i.e. after `term`.
          const releasing = store.releaseRunWatchers({ runId: RUN_ID, reason });
          await store.entered;

          // The claimed delivery now attempts to land. It must be refused.
          const delivered = await store.deliverCompletion({
            runId: RUN_ID,
            blockId: BLOCK_ID,
            waitpointId: "w_a",
            completion: completion(),
          });

          expect(delivered.outcome).toBe("terminal");
          expect(delivered.resumable).toBe(false);
          expect(await probe.hget(`wp:v1:run:{${RUN_ID}}:done`, "w_a")).toBeNull();
          expect(await probe.hget(`wp:v1:run:{${RUN_ID}}:st`, "hs")).toBe("");

          store.release();
          await releasing;
        } finally {
          probe.disconnect();
          await store.quit();
        }
      }
    );
  }

  redisTest("a withdrawal failure still cannot permit a resume", async ({ redisOptions }) => {
    class FailingWithdrawal extends WaitpointStoreCoordinator {
      override async unregisterWatcher(): Promise<never> {
        throw new Error("shard unreachable");
      }
    }
    const store = new FailingWithdrawal({ redisOptions });
    const probe = createRedisClient(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.registerBlocks({ runId: RUN_ID, blockId: BLOCK_ID, edges: [edge("w_a")] });
      await store.complete({ waitpointId: "w_a", completion: completion() });

      await expect(
        store.releaseRunWatchers({ runId: RUN_ID, reason: "cancelled" })
      ).rejects.toThrow("shard unreachable");

      // The fence went in before the failure, so the inert registration left behind is
      // reconciliation residue and can never produce a wake-up.
      expect(await probe.hget(`wp:v1:run:{${RUN_ID}}:st`, "term")).toBe("1");
      const delivered = await store.deliverCompletion({
        runId: RUN_ID,
        blockId: BLOCK_ID,
        waitpointId: "w_a",
        completion: completion(),
      });
      expect(delivered.outcome).toBe("terminal");
      expect(await probe.hget(`wp:v1:run:{${RUN_ID}}:done`, "w_a")).toBeNull();
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });
});

/**
 * Every destructive clear is fenced on the block it belongs to.
 *
 * `acknowledgeResumeHandoff` fenced `runMarkHandoffAcked` and then issued the drain as a
 * SECOND call. A rollover landing between them meant block 1's late drain deleted block 2's
 * edge fields and reconciled its pending set and receipts against them. Edge identity cannot
 * be the fence: block 2 may reuse block 1's exact fields.
 */
describe("block clears are fenced on their block", () => {
  const B1 = "blk_1";
  const B2 = "blk_2";

  async function acknowledgedCycleOne(store: WaitpointStoreCoordinator) {
    await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
    await store.createIfAbsent({ record: record("w_b"), status: "PENDING" });
    await store.registerBlocks({ runId: RUN_ID, blockId: B1, edges: [edge("w_a")] });
    await store.deliverCompletion({
      runId: RUN_ID,
      blockId: B1,
      waitpointId: "w_a",
      completion: completion(),
    });
    const acked = await store.acknowledgeResumeHandoff({ runId: RUN_ID, blockId: B1 });
    expect(acked.outcome).toBe("acknowledged");
  }

  redisTest(
    "a delayed block-1 drain is stale and leaves block 2 untouched",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await acknowledgedCycleOne(store);

        // Block 2 rolls over BEFORE block 1's drain lands, and REUSES w_a's edge field, which
        // is exactly what makes edge identity useless as a fence.
        await store.registerBlocks({
          runId: RUN_ID,
          blockId: B2,
          edges: [edge("w_a"), edge("w_b")],
          expectedPreviousBlockId: B1,
        });
        await store.deliverCompletion({
          runId: RUN_ID,
          blockId: B2,
          waitpointId: "w_a",
          completion: completion(),
        });

        const before = {
          pend: (await probe.smembers(`wp:v1:run:{${RUN_ID}}:pend`)).sort(),
          done: await probe.hgetall(`wp:v1:run:{${RUN_ID}}:done`),
          edge: await probe.hgetall(`wp:v1:run:{${RUN_ID}}:edge`),
          st: await probe.hgetall(`wp:v1:run:{${RUN_ID}}:st`),
        };
        expect(Object.keys(before.edge)).toContain(edgeField("w_a"));

        // Block 1's drain, arriving late and naming its own edges.
        const stale = await store.clearBlockState({
          runId: RUN_ID,
          blockId: B1,
          edgeIds: [edgeField("w_a")],
        });

        expect(stale.outcome).toBe("stale");
        expect(stale.currentBlockId).toBe(B2);
        // Every block 2 key, edge, pending id, receipt and handoff value is unchanged.
        expect((await probe.smembers(`wp:v1:run:{${RUN_ID}}:pend`)).sort()).toEqual(before.pend);
        expect(await probe.hgetall(`wp:v1:run:{${RUN_ID}}:done`)).toEqual(before.done);
        expect(await probe.hgetall(`wp:v1:run:{${RUN_ID}}:edge`)).toEqual(before.edge);
        expect(await probe.hgetall(`wp:v1:run:{${RUN_ID}}:st`)).toEqual(before.st);
        // And the REUSED edge field in particular survived.
        expect(Object.keys(await probe.hgetall(`wp:v1:run:{${RUN_ID}}:edge`))).toContain(
          edgeField("w_a")
        );
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest("a matching block still drains normally", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await acknowledgedCycleOne(store);

      const drained = await store.clearBlockState({
        runId: RUN_ID,
        blockId: B1,
        edgeIds: [edgeField("w_a")],
      });

      expect(drained.outcome).toBe("drained");
      expect(await probe.hgetall(`wp:v1:run:{${RUN_ID}}:edge`)).toEqual({});
      expect(await probe.hgetall(`wp:v1:run:{${RUN_ID}}:done`)).toEqual({});
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("a delayed FULL clear cannot erase a newer block", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await acknowledgedCycleOne(store);
      await store.registerBlocks({
        runId: RUN_ID,
        blockId: B2,
        edges: [edge("w_b")],
        expectedPreviousBlockId: B1,
      });

      // The whole-run clear is the most destructive path of all: it DELs all four keys.
      const stale = await store.clearBlockState({ runId: RUN_ID, blockId: B1 });

      expect(stale.outcome).toBe("stale");
      expect(stale.currentBlockId).toBe(B2);
      expect(await probe.exists(`wp:v1:run:{${RUN_ID}}:st`)).toBe(1);
      expect((await store.readBlockState(RUN_ID)).blockId).toBe(B2);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest(
    "a clear racing terminal cleanup cannot remove the tombstone",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
        await store.registerBlocks({ runId: RUN_ID, blockId: B1, edges: [edge("w_a")] });
        await store.cleanupRunBlockState({ runId: RUN_ID, reason: "terminal" });
        const before = await probe.hgetall(`wp:v1:run:{${RUN_ID}}:st`);

        const refused = await store.clearBlockState({ runId: RUN_ID, blockId: B1 });

        expect(refused.outcome).toBe("terminal");
        // The tombstone and its retention window are intact.
        expect(await probe.hget(`wp:v1:run:{${RUN_ID}}:st`, "term")).toBe("1");
        expect(await probe.hgetall(`wp:v1:run:{${RUN_ID}}:st`)).toEqual(before);
        expect(await probe.pttl(`wp:v1:run:{${RUN_ID}}:st`)).toBeGreaterThan(0);
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "the acknowledgement passes its own block id into the drain",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
        await store.registerBlocks({ runId: RUN_ID, blockId: B1, edges: [edge("w_a")] });
        await store.deliverCompletion({
          runId: RUN_ID,
          blockId: B1,
          waitpointId: "w_a",
          completion: completion(),
        });

        // Acknowledge AND drain in one call: the drain must carry B1, so it succeeds here.
        const acked = await store.acknowledgeResumeHandoff({
          runId: RUN_ID,
          blockId: B1,
          edgeIds: [edgeField("w_a")],
        });

        expect(acked.outcome).toBe("acknowledged");
        expect(await probe.hgetall(`wp:v1:run:{${RUN_ID}}:edge`)).toEqual({});
      } finally {
        probe.disconnect();
        await store.quit();
      }
    }
  );
});
