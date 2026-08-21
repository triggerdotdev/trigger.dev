// Redis-only suite: the coordinator holds no Prisma reference, so no Postgres container
// is needed. redisTest FLUSHALLs before every test, so ids may be reused across describes.
import { createRedisClient, type RedisOptions } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
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
  WaitpointNotFoundError,
  WaitpointStoreCoordinator,
  type BlockEdge,
  type WaitpointCompletion,
  type WaitpointRecordInput,
  type WatcherEntry,
} from "./storeCoordinator.js";

const ENV_ID = "env_1";
const PROJECT_ID = "proj_1";
const NOW = "2026-08-21T12:00:00.000Z";

function coordinator(redisOptions: RedisOptions) {
  return new WaitpointStoreCoordinator({ redisOptions });
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
});

describe("registerOrReport", () => {
  redisTest("registers a watcher against a PENDING waitpoint", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      const result = await store.registerOrReport({
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
        store.registerOrReport({ waitpointId: "w_missing", runId: "run_1", createdAt: NOW })
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
        waitpointId: "w_a",
        runId: "run_1",
        batchIndex: 0,
        createdAt: NOW,
      });
      await store.registerOrReport({
        waitpointId: "w_a",
        runId: "run_1",
        batchIndex: 2,
        createdAt: NOW,
      });

      const completed = await store.complete({ waitpointId: "w_a", completion: completion() });
      expect(completed.watchers).toHaveLength(2);
      expect(completed.watchers.map((w) => w.batchIndex).sort((a, b) => a! - b!)).toEqual([0, 2]);
    } finally {
      await store.quit();
    }
  });

  redisTest("carries spanIdToComplete through to the watcher entry", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.registerOrReport({
        waitpointId: "w_a",
        runId: "run_1",
        spanIdToComplete: "span_abc",
        createdAt: NOW,
      });

      const completed = await store.complete({ waitpointId: "w_a", completion: completion() });
      expect(completed.watchers[0]!.spanIdToComplete).toBe("span_abc");
      expect(completed.watchers[0]!.runId).toBe("run_1");
      expect(completed.watchers[0]!.createdAt).toBe(NOW);
    } finally {
      await store.quit();
    }
  });
});

describe("complete", () => {
  redisTest("flips PENDING to COMPLETED and returns the watchers", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.registerOrReport({ waitpointId: "w_a", runId: "run_1", createdAt: NOW });
      await store.registerOrReport({ waitpointId: "w_a", runId: "run_2", createdAt: NOW });

      const result = await store.complete({ waitpointId: "w_a", completion: completion() });

      expect(result.outcome).toBe("completed");
      expect(result.watchers.map((w) => w.runId).sort()).toEqual(["run_1", "run_2"]);
    } finally {
      await store.quit();
    }
  });

  redisTest("is idempotent and returns the watchers again", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      await store.registerOrReport({ waitpointId: "w_a", runId: "run_1", createdAt: NOW });

      const first = await store.complete({ waitpointId: "w_a", completion: completion() });
      const second = await store.complete({
        waitpointId: "w_a",
        completion: completion({ output: { inline: '{"second":true}' } }),
      });

      expect(first.outcome).toBe("completed");
      expect(second.outcome).toBe("already");
      // The FIRST completion wins, matching the guard on status = PENDING.
      expect(second.completion?.output).toEqual({ inline: '{"ok":true}' });
      expect(second.watchers.map((w) => w.runId)).toEqual(["run_1"]);
    } finally {
      await store.quit();
    }
  });

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

  redisTest("returns an empty watcher list when nobody is blocked", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      await store.createIfAbsent({ record: record("w_a"), status: "PENDING" });
      const result = await store.complete({ waitpointId: "w_a", completion: completion() });
      expect(result.watchers).toEqual([]);
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "keeps the watcher list intact when the completion field is absent on an already-completed record",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      const probe = createRedisClient(redisOptions);
      try {
        // registerOrReport never lets a watcher land once status is COMPLETED, so this
        // shape is forced by hand: it pins that an absent 'c' field decodes to an
        // undefined completion without disturbing the watchers that follow it in the
        // reply array.
        await store.createIfAbsent({ record: record("w_a"), status: "COMPLETED" });
        const watcher: WatcherEntry = { runId: "run_1", createdAt: NOW };
        await probe.hset("wp:{w_a}:w", watcherField("run_1"), JSON.stringify(watcher));

        const result = await store.complete({ waitpointId: "w_a", completion: completion() });

        expect(result.outcome).toBe("already");
        expect(result.completion).toBeUndefined();
        expect(result.watchers).toHaveLength(1);
        expect(result.watchers[0]!.runId).toBe("run_1");
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
      await store.registerOrReport({ waitpointId: "w_a", runId: "run_1", createdAt: NOW });
      await store.complete({ waitpointId: "w_a", completion: completion() });

      // -1 means the key exists with no expiry. Anything >= 0 breaks the retention rule.
      expect(await probe.pttl("wp:{w_a}")).toBe(-1);
      expect(await probe.pttl("wp:{w_a}:w")).toBe(-1);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });
});

// No coordinator method calls runAbsorbBlockers/runClear/wpIdemReserve yet — a later task
// wires those in. Registered directly on a raw client so the Lua itself is exercised now.
describe("runAbsorbBlockers, runClear and wpIdemReserve (direct Lua)", () => {
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
          "2",
          "w_solo",
          fieldA,
          "{}",
          "",
          "w_solo",
          fieldB,
          "{}",
          envelope
        );

        expect(reply).toEqual(["0", "0", "w_solo", envelope]);
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
          "2",
          "w_solo",
          fieldB,
          "{}",
          envelope,
          "w_solo",
          fieldA,
          "{}",
          ""
        );

        expect(reply).toEqual(["0", "0", "w_solo", envelope]);
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
        "2",
        "w_a",
        edgeField("w_a", 0),
        "{}",
        "",
        "w_b",
        edgeField("w_b", 0),
        "{}",
        ""
      );

      expect(reply).toEqual(["2", "2"]);
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
          "2",
          "w_a",
          edgeField("w_a", 0),
          "{}",
          "",
          "w_b",
          edgeField("w_b", 0),
          "{}",
          envelope
        );

        expect(reply).toEqual(["1", "1", "w_b", envelope]);
        expect(await client.scard(keys.pend)).toBe(1);
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
          "2",
          "w_a",
          edgeField("w_a", 0),
          "{}",
          "",
          "w_a",
          edgeField("w_a", 1),
          "{}",
          ""
        );

        expect(reply).toEqual(["1", "1"]);
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
          "1",
          "w_a",
          edgeField("w_a", 0),
          "{}",
          ""
        );

        expect(reply).toEqual(["0", "0", "w_a", envelope]);
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

      // n says 2 groups but only one group (4 ARGV entries) is supplied.
      await expect(
        client.runAbsorbBlockers(keys.pend, keys.done, keys.edge, "2", "w_solo", field, "{}", "")
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
          client.runClear(keys.pend, keys.done, keys.edge, "2", field)
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
  redisTest("creates the waitpoint and wins the reservation", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const result = await store.createWithIdempotencyKey({
        record: record("w_a", { idempotencyKey: "key-1", userProvidedIdempotencyKey: true }),
        environmentId: ENV_ID,
        idempotencyKey: "key-1",
      });

      expect(result).toEqual({ waitpointId: "w_a", created: true });
    } finally {
      await store.quit();
    }
  });

  redisTest("returns the winner's id and deletes the loser", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await store.createWithIdempotencyKey({
        record: record("w_first", { idempotencyKey: "key-1", userProvidedIdempotencyKey: true }),
        environmentId: ENV_ID,
        idempotencyKey: "key-1",
      });

      const second = await store.createWithIdempotencyKey({
        record: record("w_second", { idempotencyKey: "key-1", userProvidedIdempotencyKey: true }),
        environmentId: ENV_ID,
        idempotencyKey: "key-1",
      });

      expect(second).toEqual({ waitpointId: "w_first", created: false });
      // The loser cleans up after itself: nothing ever referenced its id.
      expect(await probe.exists("wp:{w_second}")).toBe(0);
      expect(await probe.exists("wp:{w_first}")).toBe(1);
    } finally {
      probe.disconnect();
      await store.quit();
    }
  });

  redisTest("sets no expiry when the record carries none", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await store.createWithIdempotencyKey({
        record: record("w_a", { idempotencyKey: "key-1", userProvidedIdempotencyKey: true }),
        environmentId: ENV_ID,
        idempotencyKey: "key-1",
      });

      // The common case. An expiry appearing here would be a retention rule violation.
      expect(await probe.pttl(`wp:idem:{${ENV_ID}}:key-1`)).toBe(-1);
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
        record: record("w_a", {
          idempotencyKey: "key-1",
          userProvidedIdempotencyKey: true,
          idempotencyKeyExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        environmentId: ENV_ID,
        idempotencyKey: "key-1",
      });

      const ttl = await probe.pttl(`wp:idem:{${ENV_ID}}:key-1`);
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
        record: record("w_a", { idempotencyKey: "key-1" }),
        environmentId: "env_1",
        idempotencyKey: "key-1",
      });

      const other = await store.createWithIdempotencyKey({
        record: record("w_b", { idempotencyKey: "key-1", environmentId: "env_2" }),
        environmentId: "env_2",
        idempotencyKey: "key-1",
      });

      expect(other).toEqual({ waitpointId: "w_b", created: true });
    } finally {
      await store.quit();
    }
  });
});

describe("the single-slot guard", () => {
  redisTest("rejects an invocation whose keys span two tags", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      // Reaches the same wrapper every operation goes through, so this proves the guard
      // is live at the call path and not only in the pure unit test.
      expect(() =>
        store.assertKeysForTest("wpComplete", ["wp:{w_a}", "wp:run:{run_1}:pend"])
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
          runId: RUN_ID,
          edges: [edge("w_a", { batchIndex: 0 }), edge("w_a", { batchIndex: 2 })],
        });

        // The count this replaces was a COUNT(*) over waitpoint rows, so two edges for
        // one waitpoint contributed one. Both numbers must say 1, not 2.
        expect(result.pendingOfRequested).toBe(1);
        expect(result.storePendingTotal).toBe(1);

        // The edges themselves stay distinct — that multiplicity is what produces the
        // repeats in the cycle's ordered id list.
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
          runId: RUN_ID,
          edges: [edge("w_a", { reported: completion() }), edge("w_b")],
        });

        expect(result.pendingOfRequested).toBe(1);
        expect(result.storePendingTotal).toBe(1);
        expect(result.alreadyDelivered.map((d) => d.waitpointId)).toEqual(["w_a"]);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("reports a repeated already-delivered id once", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const result = await store.absorbBlockers({
        runId: RUN_ID,
        edges: [
          edge("w_a", { batchIndex: 0, reported: completion() }),
          edge("w_a", { batchIndex: 1, reported: completion() }),
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
      // The completion landed between register and absorb, so it is already delivered.
      await store.deliverCompletion({
        runId: RUN_ID,
        waitpointId: "w_a",
        completion: completion(),
      });

      const result = await store.absorbBlockers({ runId: RUN_ID, edges: [edge("w_a")] });

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
      const first = await store.absorbBlockers({ runId: RUN_ID, edges: [edge("w_a")] });
      const second = await store.absorbBlockers({ runId: RUN_ID, edges: [edge("w_a")] });

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
        runId: RUN_ID,
        edges: [edge("w_a", { spanIdToComplete: "span_first" })],
      });
      await store.absorbBlockers({
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
      await store.absorbBlockers({ runId: RUN_ID, edges: [edge("w_a")] });

      const result = await store.absorbBlockers({ runId: RUN_ID, edges: [] });

      // pendingOfRequested is 0 because nothing was requested. storePendingTotal is the
      // run's whole store-resident set, which is NOT empty.
      expect(result.pendingOfRequested).toBe(0);
      expect(result.storePendingTotal).toBe(1);
      expect(result.alreadyDelivered).toEqual([]);
    } finally {
      await store.quit();
    }
  });

  redisTest("sets no TTL on any run key", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    const probe = createRedisClient(redisOptions);
    try {
      await store.absorbBlockers({ runId: RUN_ID, edges: [edge("w_a")] });
      await store.deliverCompletion({
        runId: RUN_ID,
        waitpointId: "w_a",
        completion: completion(),
      });

      // -1 is "exists, no expiry"; -2 is "no key". Neither is a TTL. `pend` is emptied by
      // the delivery, and Redis deletes an empty set, so -2 is expected there.
      for (const key of [
        `wp:run:{${RUN_ID}}:pend`,
        `wp:run:{${RUN_ID}}:done`,
        `wp:run:{${RUN_ID}}:edge`,
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
      await store.absorbBlockers({ runId: RUN_ID, edges: [edge("w_a"), edge("w_b")] });

      expect(
        (
          await store.deliverCompletion({
            runId: RUN_ID,
            waitpointId: "w_a",
            completion: completion(),
          })
        ).storePendingTotal
      ).toBe(1);

      expect(
        (
          await store.deliverCompletion({
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
      await store.absorbBlockers({ runId: RUN_ID, edges: [edge("w_a")] });
      await store.deliverCompletion({
        runId: RUN_ID,
        waitpointId: "w_a",
        completion: completion(),
      });
      const again = await store.deliverCompletion({
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
          runId: RUN_ID,
          edges: [
            edge("w_a", { batchIndex: 0, completedAfter: NOW, type: "DATETIME" }),
            edge("w_b"),
          ],
        });
        await store.deliverCompletion({
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
      await store.absorbBlockers({ runId: RUN_ID, edges: [edge("w_a"), edge("w_b")] });
      await store.deliverCompletion({
        runId: RUN_ID,
        waitpointId: "w_a",
        completion: completion(),
      });

      expect((await store.clearBlockState({ runId: RUN_ID, edgeIds: ["w_a#"] })).outcome).toBe(
        "drained"
      );

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
          runId: RUN_ID,
          edges: [edge("w_a", { batchIndex: 0 }), edge("w_a", { batchIndex: 1 })],
        });
        await store.deliverCompletion({
          runId: RUN_ID,
          waitpointId: "w_a",
          completion: completion(),
        });

        await store.clearBlockState({ runId: RUN_ID, edgeIds: ["w_a#0"] });

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
      await store.absorbBlockers({ runId: RUN_ID, edges: [edge("w_kept")] });
      await store.deliverCompletion({
        runId: RUN_ID,
        waitpointId: "w_orphan",
        completion: completion(),
      });

      expect((await store.readBlockState(RUN_ID)).deliveredIds).toEqual(["w_orphan"]);

      await store.clearBlockState({ runId: RUN_ID, edgeIds: ["w_nothing#"] });

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
      await store.absorbBlockers({ runId: RUN_ID, edges: [edge("w_a"), edge("w_b")] });

      expect((await store.clearBlockState({ runId: RUN_ID })).outcome).toBe("cleared");
      expect(await store.readBlockState(RUN_ID)).toEqual({
        pendingIds: [],
        deliveredIds: [],
        edges: [],
      });
    } finally {
      await store.quit();
    }
  });
});
