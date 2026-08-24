import { describe, expect, it } from "vitest";
import { RoutingRunStore } from "./runOpsStore.js";
import type { ReadClient, RunStore } from "./types.js";

// Pins the routing ALGEBRA: probe order, merge precedence, and the two id-less fallbacks that
// differ by role. No DB — each slot is a fake RunStore recording into ONE shared ordered log, so a
// sequential probe's leg order and a merge's winner are both observable. Real two-DB topology stays
// with the heteroRunOpsPostgresTest suites.
//
// MUST NOT assert invocation order for a PARALLEL fan-out: both legs are issued before either
// resolves, so the order they are created in is not a behaviour.

type Slot = string;

type Call = { slot: Slot; method: string };

type FakeConfig = {
  // Rows this store returns from findRun / findRuns / findRunOrThrow, regardless of filter.
  runs?: Array<Record<string, unknown>>;
  // Edge rows this store returns from findManyTaskRunWaitpoints, regardless of filter.
  edges?: Array<Record<string, unknown>>;
  // Waitpoint rows this store returns from findWaitpoint, regardless of filter.
  waitpoint?: Record<string, unknown> | null;
  // Rows this store returns from findRunsByIdempotencyKeys, regardless of filter.
  idempotencyMatches?: Array<Record<string, unknown>>;
  // Waitpoint ids this store reports as pending (present = pending here) for count/collect probes.
  pendingWaitpointIds?: string[];
};

type FakeStore = RunStore & {
  slot: Slot;
  primaryReadClient: { __primary: Slot };
};

function fakeStore(slot: Slot, log: Call[], config: FakeConfig = {}): FakeStore {
  const record = (method: string) => log.push({ slot, method });
  const runs = config.runs ?? [];

  const store: Partial<FakeStore> = {
    slot,
    primaryReadClient: { __primary: slot },

    findRun: ((_where: unknown, _args?: unknown) => {
      record("findRun");
      return Promise.resolve((runs[0] ?? null) as never);
    }) as FakeStore["findRun"],

    findRunOnPrimary: ((_where: unknown, _args?: unknown) => {
      record("findRunOnPrimary");
      return Promise.resolve((runs[0] ?? null) as never);
    }) as FakeStore["findRunOnPrimary"],

    findRunOrThrow: ((_where: unknown, _args?: unknown) => {
      record("findRunOrThrow");
      if (runs[0] === undefined) {
        return Promise.reject(new Error(`no run on ${slot}`)) as never;
      }
      return Promise.resolve(runs[0] as never);
    }) as FakeStore["findRunOrThrow"],

    findRuns: ((_args: unknown, _client?: ReadClient) => {
      record("findRuns");
      return Promise.resolve(runs as never);
    }) as FakeStore["findRuns"],

    createRun: ((_params: unknown) => {
      record("createRun");
      return Promise.resolve({ slot } as never);
    }) as FakeStore["createRun"],

    createTaskRunCheckpoint: ((_args: unknown) => {
      record("createTaskRunCheckpoint");
      return Promise.resolve({ slot } as never);
    }) as FakeStore["createTaskRunCheckpoint"],

    findWaitpoint: ((_args: unknown, _client?: ReadClient) => {
      record("findWaitpoint");
      return Promise.resolve((config.waitpoint ?? null) as never);
    }) as FakeStore["findWaitpoint"],

    updateWaitpoint: ((_args: unknown) => {
      record("updateWaitpoint");
      return Promise.resolve({ slot } as never);
    }) as FakeStore["updateWaitpoint"],

    createWaitpoint: ((_args: unknown) => {
      record("createWaitpoint");
      return Promise.resolve({ slot } as never);
    }) as FakeStore["createWaitpoint"],

    runInTransaction: ((_runId: unknown, fn: (store: unknown, tx: unknown) => unknown) => {
      record("runInTransaction");
      return Promise.resolve(fn(store, {}));
    }) as FakeStore["runInTransaction"],

    findManyTaskRunWaitpoints: ((_args: unknown, _client?: ReadClient) => {
      record("findManyTaskRunWaitpoints");
      return Promise.resolve((config.edges ?? []) as never);
    }) as FakeStore["findManyTaskRunWaitpoints"],

    updateManyWaitpoints: ((_args: unknown) => {
      record("updateManyWaitpoints");
      return Promise.resolve({ count: 1 } as never);
    }) as FakeStore["updateManyWaitpoints"],

    findRunsByIdempotencyKeys: ((_args: unknown, _client?: ReadClient) => {
      record("findRunsByIdempotencyKeys");
      return Promise.resolve((config.idempotencyMatches ?? []) as never);
    }) as FakeStore["findRunsByIdempotencyKeys"],

    countPendingWaitpointsWithPresence: ((waitpointIds: string[], _client?: ReadClient) => {
      record("countPendingWaitpointsWithPresence");
      const pending = new Set(config.pendingWaitpointIds ?? []);
      const found = waitpointIds.filter((id) => pending.has(id));
      return Promise.resolve({ pendingIds: found, presentIds: found } as never);
    }) as FakeStore["countPendingWaitpointsWithPresence"],
  };

  return store as unknown as FakeStore;
}

// Deterministic residency by id prefix via the classify seam (no dependence on id-shape rules).
function buildRouter(newConfig: FakeConfig = {}, legacyConfig: FakeConfig = {}) {
  const log: Call[] = [];
  const newStore = fakeStore("new", log, newConfig);
  const legacyStore = fakeStore("legacy", log, legacyConfig);
  const router = new RoutingRunStore({
    new: newStore,
    legacy: legacyStore,
    classify: (id: string) => (id.startsWith("new") ? "NEW" : "LEGACY"),
  });
  return { router, newStore, legacyStore, log };
}

const trace = (log: Call[]) => log.map((c) => `${c.slot}:${c.method}`);

// A parallel fan-out issues every leg before any resolves, so the ORDER legs appear in the log is
// NOT a behaviour and MUST NOT be asserted. Compare the multiset of slots instead. Order assertions
// via `trace` are valid only for the sequential (two-or-fewer-store) probe.
const slots = (log: Call[], method?: string) =>
  (method ? log.filter((c) => c.method === method) : log).map((c) => c.slot).sort();

describe("RoutingRunStore #probeOrder — new then legacy, sequential", () => {
  it("probes new BEFORE legacy for an unrouted findRun", async () => {
    const { router, log } = buildRouter();
    await router.findRun({ spanId: "span_x" });
    expect(trace(log)).toEqual(["new:findRun", "legacy:findRun"]);
  });

  it("stops at the first non-null leg and never consults legacy", async () => {
    const { router, log } = buildRouter({ runs: [{ id: "r1" }] });
    await router.findRun({ spanId: "span_x" });
    expect(trace(log)).toEqual(["new:findRun"]);
  });

  it("gives the LAST probe leg the canonical not-found throw", async () => {
    const { router, log } = buildRouter();
    await expect(router.findRunOrThrow({ spanId: "span_x" })).rejects.toThrow("no run on legacy");
    // new is probed with the nullable read; only legacy is asked to throw.
    expect(trace(log)).toEqual(["new:findRun", "legacy:findRunOrThrow"]);
  });

  it("probes each store's own primary for a read-your-writes unrouted findRun", async () => {
    const { router, log } = buildRouter();
    await router.findRunOnPrimary({ spanId: "span_x" });
    expect(trace(log)).toEqual(["new:findRunOnPrimary", "legacy:findRunOnPrimary"]);
  });
});

describe("RoutingRunStore #precedence — NEW wins a merge", () => {
  it("keeps the NEW row for a duplicate run id on an open predicate", async () => {
    const { router } = buildRouter(
      { runs: [{ id: "dup", from: "new" }] },
      { runs: [{ id: "dup", from: "legacy" }] }
    );
    const rows = (await router.findRuns({
      where: { runtimeEnvironmentId: "env_1" },
      select: { id: true, from: true },
    })) as Array<{ id: string; from: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.from).toBe("new");
  });

  // Every merge in the router MUST resolve a duplicate id NEW-wins, edges included.
  it("keeps the NEW row for a duplicate edge id on a waitpoint-keyed edge read", async () => {
    const { router } = buildRouter(
      { edges: [{ id: "edge_dup", taskRunId: "new_run" }] },
      { edges: [{ id: "edge_dup", taskRunId: "legacy_run" }] }
    );
    const edges = (await router.findManyTaskRunWaitpoints({
      where: { waitpointId: "waitpoint_x" },
      select: { id: true, taskRunId: true },
    })) as Array<{ id: string; taskRunId: string }>;
    expect(edges).toHaveLength(1);
    expect(edges[0]?.taskRunId).toBe("new_run");
  });
});

describe("RoutingRunStore id-less fallbacks — the two defaults differ by role", () => {
  it("routes an id-less create to new (#idlessRouteShard)", async () => {
    const { router, log } = buildRouter();
    await router.createRun({ data: {} } as never);
    expect(trace(log)).toEqual(["new:createRun"]);
  });

  it("throws for an id-less checkpoint create rather than defaulting to new", async () => {
    const { router, log } = buildRouter();
    await expect(router.createTaskRunCheckpoint({ data: {} } as never)).rejects.toThrow(
      "createTaskRunCheckpoint requires ownerRunId to route"
    );
    expect(trace(log)).toEqual([]);
  });

  it("throws for a batch create with no id rather than defaulting to new", async () => {
    const { router } = buildRouter();
    await expect(router.createBatchTaskRun({} as never)).rejects.toThrow(
      "createBatchTaskRun requires data.id to route"
    );
  });

  it("routes an id-less waitpoint update to legacy (#idlessWaitpointShard)", async () => {
    const { router, log } = buildRouter();
    await router.updateWaitpoint({ where: { idempotencyKey: "k" }, data: {} } as never);
    expect(trace(log)).toEqual(["legacy:updateWaitpoint"]);
  });
});

describe("RoutingRunStore id-to-shard-key seam", () => {
  it("defaults to the core resolveShard when neither seam is injected", async () => {
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log),
      legacy: fakeStore("legacy", log),
    });
    // A gen-1 v1 body (version "1" at index 25) routes to new.
    await router.findRun({ id: "a".repeat(24) + "01" });
    expect(trace(log)).toEqual(["new:findRun"]);
  });

  it("keeps the legacy classify seam working, so the corpus stays green", async () => {
    const { router, log } = buildRouter();
    await router.findRun({ id: "new_run_1" });
    expect(trace(log)).toEqual(["new:findRun"]);
  });

  it("prefers an injected resolveShard over classify", async () => {
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log),
      legacy: fakeStore("legacy", log),
      classify: () => "NEW",
      resolveShard: () => "legacy",
    });
    await router.findRun({ id: "anything" });
    expect(trace(log)).toEqual(["legacy:findRun"]);
  });

  // An id naming a shard nobody configured must fail loud rather than fall back to a default
  // store, which would be a silent read against the wrong database. The throw is SYNCHRONOUS:
  // routing happens before any query is issued, and `await store.findRun(...)` propagates it
  // identically. Only a `.catch()`-style caller would see the difference.
  it("throws for an id resolving to an unconfigured shard key", () => {
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log),
      legacy: fakeStore("legacy", log),
      resolveShard: () => "a",
    });
    expect(() => router.findRun({ id: "anything" })).toThrow(
      'no store is configured for shard key "a"'
    );
    expect(trace(log)).toEqual([]);
  });
});

function buildNShardRouter(shardKeys: string[], opts: { aliasOf?: Record<string, string> } = {}) {
  const log: Call[] = [];
  const newStore = fakeStore("new", log);
  const legacyStore = fakeStore("legacy", log);
  const byKey: Record<string, FakeStore> = { new: newStore, legacy: legacyStore };
  const shards = shardKeys.map((key) => {
    const aliasOf = opts.aliasOf?.[key];
    const store = aliasOf ? byKey[aliasOf]! : fakeStore(key as Slot, log);
    byKey[key] = store;
    return aliasOf ? { key, store, aliasOf } : { key, store };
  });
  const router = new RoutingRunStore({
    new: newStore,
    legacy: legacyStore,
    shards,
    resolveShard: (id: string) => id.split(":")[0]!,
  });
  return { router, log, byKey };
}

describe("RoutingRunStore #distinctStores — one entry per database", () => {
  it("routes an id to its gen-2 shard", async () => {
    const { router, log } = buildNShardRouter(["a", "b"]);
    await router.findRun({ id: "a:run_1" });
    expect(trace(log)).toEqual(["a:findRun"]);
  });

  it("counts an aliased shard's database ONCE in a sum", async () => {
    // "a" aliases "new": two keys, one database.
    const { router, log } = buildNShardRouter(["a"], { aliasOf: { a: "new" } });
    const result = await router.updateManyWaitpoints({
      where: { status: "PENDING" },
      data: {},
    } as never);
    expect(trace(log)).toEqual(["new:updateManyWaitpoints", "legacy:updateManyWaitpoints"]);
    expect(result.count).toBe(2);
  });

  it("still routes an id whose key is an alias", async () => {
    const { router, log, byKey } = buildNShardRouter(["a"], { aliasOf: { a: "new" } });
    expect(byKey.a).toBe(byKey.new);
    await router.findRun({ id: "a:run_1" });
    expect(trace(log)).toEqual(["new:findRun"]);
  });

  it("keeps #fanOutPartitioned key-driven so an aliased bucket is not dropped", async () => {
    const { router, log } = buildNShardRouter(["a"], { aliasOf: { a: "new" } });
    await router.findRunsByIds(["a:r1", "legacy:r2"]);
    // Both buckets get a leg. The aliased bucket routes onto the shared store.
    expect(log.filter((c) => c.method === "findRuns")).toHaveLength(2);
  });

  it("rejects an aliasOf naming an unconfigured key", () => {
    const log: Call[] = [];
    expect(
      () =>
        new RoutingRunStore({
          new: fakeStore("new", log),
          legacy: fakeStore("legacy", log),
          shards: [{ key: "a", store: fakeStore("a" as Slot, log), aliasOf: "nope" }],
        })
    ).toThrow('aliasOf "nope"');
  });
});

describe("RoutingRunStore probe at N", () => {
  it("keeps the sequential short circuit at two distinct stores", async () => {
    const { router, log } = buildRouter({ runs: [{ id: "r1" }] });
    await router.findRun({ spanId: "span_x" });
    expect(trace(log)).toEqual(["new:findRun"]);
  });

  it("issues every leg in parallel above two distinct stores", async () => {
    // "b" carries the only hit. A sequential probe would stop the moment it found a result; a
    // true parallel fan-out queries every OTHER leg too, since all legs are issued before any
    // resolves. Miss-path (every leg misses) throw semantics are covered separately below.
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log),
      legacy: fakeStore("legacy", log),
      shards: [
        { key: "a", store: fakeStore("a", log) },
        { key: "b", store: fakeStore("b", log, { runs: [{ id: "r1" }] }) },
      ],
      resolveShard: (id: string) => id.split(":")[0]!,
    });
    await router.findRun({ spanId: "span_x" });
    expect(slots(log)).toEqual(["a", "b", "legacy", "new"]);
  });

  it("gives the legacy leg the canonical throw when every leg misses", async () => {
    const { router } = buildNShardRouter(["a"]);
    await expect(router.findRunOrThrow({ spanId: "span_x" })).rejects.toThrow("no run on legacy");
  });

  it("tolerates a failing leg when another leg wins", async () => {
    const log: Call[] = [];
    const broken = fakeStore("a", log);
    (broken as { findRun: unknown }).findRun = () => Promise.reject(new Error("shard a is down"));
    const router = new RoutingRunStore({
      new: fakeStore("new", log, { runs: [{ id: "r1" }] }),
      legacy: fakeStore("legacy", log),
      shards: [{ key: "a", store: broken }],
      resolveShard: (id: string) => id.split(":")[0]!,
    });
    await expect(router.findRun({ spanId: "span_x" })).resolves.toMatchObject({ id: "r1" });
  });

  it("surfaces a leg failure when no leg wins", async () => {
    const log: Call[] = [];
    const broken = fakeStore("a", log);
    (broken as { findRun: unknown }).findRun = () => Promise.reject(new Error("shard a is down"));
    const router = new RoutingRunStore({
      new: fakeStore("new", log),
      legacy: fakeStore("legacy", log),
      shards: [{ key: "a", store: broken }],
      resolveShard: (id: string) => id.split(":")[0]!,
    });
    await expect(router.findRun({ spanId: "span_x" })).rejects.toThrow("shard a is down");
  });
});

describe("RoutingRunStore merge precedence and duplicate alarm", () => {
  const spy = () => {
    const seen: string[][] = [];
    return {
      metrics: {
        recordDuplicateId: (k: string[]) => seen.push(k),
        recordWaitpointProbeFallback() {},
      },
      seen,
    };
  };

  it("stays silent for a duplicate run id across the gen-1 pair", async () => {
    const { metrics, seen } = spy();
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log, { runs: [{ id: "dup", from: "new" }] }),
      legacy: fakeStore("legacy", log, { runs: [{ id: "dup", from: "legacy" }] }),
      metrics,
    });
    const rows = (await router.findRuns({
      where: { runtimeEnvironmentId: "env_1" },
      select: { id: true, from: true },
    })) as Array<{ from: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.from).toBe("new"); // NEW wins the precedence merge
    expect(seen).toEqual([]);
  });

  it("alarms for a duplicate involving a gen-2 shard and still picks deterministically", async () => {
    const { metrics, seen } = spy();
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log),
      legacy: fakeStore("legacy", log),
      shards: [
        { key: "a", store: fakeStore("a", log, { runs: [{ id: "dup", from: "a" }] }) },
        { key: "b", store: fakeStore("b", log, { runs: [{ id: "dup", from: "b" }] }) },
      ],
      resolveShard: (id: string) => id.split(":")[0]!,
      metrics,
    });
    const rows = (await router.findRuns({
      where: { runtimeEnvironmentId: "env_1" },
      select: { id: true, from: true },
    })) as Array<{ from: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.from).toBe("b"); // last in #precedence [legacy, new, a, b] wins
    expect(seen).toEqual([["a", "b"]]);
  });

  it("passes through an edge row whose projection omits id", async () => {
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log, { edges: [{ taskRunId: "r1" }] }),
      legacy: fakeStore("legacy", log, { edges: [{ taskRunId: "r2" }] }),
    });
    const edges = (await router.findManyTaskRunWaitpoints({
      where: { waitpointId: "w" },
      select: { taskRunId: true },
    })) as Array<{ taskRunId: string }>;
    expect(edges).toHaveLength(2);
  });
});

describe("RoutingRunStore findRunsByIdempotencyKeys tiebreak", () => {
  const older = new Date("2026-01-01T00:00:00Z");
  const newer = new Date("2026-01-02T00:00:00Z");
  const match = (id: string, createdAt: Date) => ({
    id,
    createdAt,
    friendlyId: `run_${id}`,
    idempotencyKey: "k",
    idempotencyKeyExpiresAt: null,
  });

  it("keeps NEW-wins across the gen-1 pair even when legacy is older", async () => {
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log, { idempotencyMatches: [match("n1", newer)] }),
      legacy: fakeStore("legacy", log, { idempotencyMatches: [match("l1", older)] }),
    });
    const rows = await router.findRunsByIdempotencyKeys({
      runtimeEnvironmentId: "env",
      taskIdentifier: "t",
      idempotencyKeys: ["k"],
    });
    expect(rows.map((r) => r.id)).toEqual(["n1"]);
  });

  it("takes the earliest createdAt once a gen-2 shard is involved", async () => {
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log, { idempotencyMatches: [match("n1", newer)] }),
      legacy: fakeStore("legacy", log),
      shards: [
        { key: "a", store: fakeStore("a", log, { idempotencyMatches: [match("a1", older)] }) },
      ],
      resolveShard: (id: string) => id.split(":")[0]!,
    });
    const rows = await router.findRunsByIdempotencyKeys({
      runtimeEnvironmentId: "env",
      taskIdentifier: "t",
      idempotencyKeys: ["k"],
    });
    expect(rows.map((r) => r.id)).toEqual(["a1"]);
  });
});

describe("RoutingRunStore countPendingWaitpoints — disjoint-sum partition", () => {
  // resolveShard: "x:..." -> "x" (a gen-2 shard); a bare cuid -> "legacy".
  function partitionRouter(pending: Record<string, string[]>, spy?: (k: string[]) => void) {
    const log: Call[] = [];
    const mk = (slot: string) => fakeStore(slot, log, { pendingWaitpointIds: pending[slot] ?? [] });
    const router = new RoutingRunStore({
      new: mk("new"),
      legacy: mk("legacy"),
      shards: [
        { key: "a", store: mk("a") },
        { key: "b", store: mk("b") },
      ],
      resolveShard: (id: string) => (id.includes(":") ? id.split(":")[0]! : "legacy"),
      ...(spy ? { metrics: { recordDuplicateId: spy, recordWaitpointProbeFallback() {} } } : {}),
    });
    return { router, log };
  }
  const countCalls = (log: Call[]) => slots(log, "countPendingWaitpointsWithPresence");

  it("sends a gen-2 absent id to its own shard only", async () => {
    const { router, log } = partitionRouter({ b: ["b:w1"] });
    expect(await router.countPendingWaitpoints(["b:w1"], undefined, "a:run")).toBe(1);
    expect(countCalls(log)).toEqual(["a", "b"]); // run shard a (presence) + fallback b
  });

  it("contributes zero for a gen-2 id whose shard IS the run's shard", async () => {
    const { router, log } = partitionRouter({});
    expect(await router.countPendingWaitpoints(["a:w1"], undefined, "a:run")).toBe(0);
    expect(countCalls(log)).toEqual(["a"]); // absent on a; no fallback leg (b-bucket empty, a skipped)
  });

  it("probes BOTH gen-1 stores for a cuid absent id when the run is on a gen-2 shard", async () => {
    const { router, log } = partitionRouter({ legacy: ["cuid_w1"] });
    expect(await router.countPendingWaitpoints(["cuid_w1"], undefined, "a:run")).toBe(1);
    expect(countCalls(log)).toEqual(["a", "legacy", "new"]);
  });

  it("probes only legacy for a cuid when the run is on new", async () => {
    const { router, log } = partitionRouter({ legacy: ["cuid_w1"] });
    expect(await router.countPendingWaitpoints(["cuid_w1"], undefined, "new:run")).toBe(1);
    // run shard resolves "new:run" -> "new" (presence); cuid -> {legacy, new} minus new = legacy
    expect(countCalls(log)).toEqual(["legacy", "new"]);
  });

  it("probes only new for a cuid when the run is on legacy", async () => {
    const { router, log } = partitionRouter({ new: ["cuid_w1"] });
    expect(await router.countPendingWaitpoints(["cuid_w1"], undefined, "cuid_run")).toBe(1);
    // run shard resolves cuid -> "legacy"; cuid -> {legacy, new} minus legacy = new only
    expect(countCalls(log)).toEqual(["legacy", "new"]);
  });

  it("counts a drain-mirrored cuid ONCE and stays silent", async () => {
    const seen: string[][] = [];
    const { router } = partitionRouter({ new: ["cuid_w1"], legacy: ["cuid_w1"] }, (k) =>
      seen.push(k)
    );
    expect(await router.countPendingWaitpoints(["cuid_w1"], undefined, "a:run")).toBe(1);
    expect(seen).toEqual([]); // the gen-1 mirror is expected, never alarmed
  });

  it("fails loud when an absent id resolves to an unconfigured shard key", async () => {
    // "c:w1" resolves to shard "c", which is not configured. Silently dropping it would under-count
    // a pending waitpoint and prematurely unblock the run — so it must throw, not skip.
    const { router } = partitionRouter({});
    await expect(router.countPendingWaitpoints(["c:w1"], undefined, "a:run")).rejects.toThrow(
      'unconfigured shard key "c"'
    );
  });

  it("returns zero for an id absent everywhere", async () => {
    const { router } = partitionRouter({});
    expect(await router.countPendingWaitpoints(["b:w9"], undefined, "a:run")).toBe(0);
  });

  it("returns the true total for a mixed gen-2 and cuid set with no double count", async () => {
    const { router } = partitionRouter({
      b: ["b:w1"],
      legacy: ["cuid_w1"],
      new: ["cuid_w1", "cuid_w2"],
    });
    const count = await router.countPendingWaitpoints(
      ["b:w1", "cuid_w1", "cuid_w2", "b:w9"],
      undefined,
      "a:run"
    );
    expect(count).toBe(3); // b:w1 + cuid_w1 (mirror, once) + cuid_w2; b:w9 absent
  });
});

describe("RoutingRunStore waitpoint probes at N", () => {
  it("routes a gen-2 waitpoint directly, with no probe", async () => {
    const { router, log } = buildNShardRouter(["a", "b"]);
    await router.updateWaitpoint({ where: { id: "b:w1" }, data: {} } as never);
    expect(trace(log)).toEqual(["b:updateWaitpoint"]);
  });

  it("keeps a cuid waitpoint on the gen-1 pair and never probes a gen-2 shard", async () => {
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log, { waitpoint: { id: "cuid_w1" } }),
      legacy: fakeStore("legacy", log),
      shards: [{ key: "a", store: fakeStore("a", log) }],
      resolveShard: (id: string) => (id.includes(":") ? id.split(":")[0]! : "legacy"),
    });
    await router.updateWaitpoint({ where: { id: "cuid_w1" }, data: {} } as never);
    expect(log.map((c) => c.slot)).not.toContain("a");
  });

  it("records a probe fallback when the waitpoint is not on the store its id names", async () => {
    const falls: Array<[string, string]> = [];
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log, { waitpoint: { id: "cuid_w1" } }),
      legacy: fakeStore("legacy", log, { waitpoint: null }),
      metrics: {
        recordDuplicateId() {},
        recordWaitpointProbeFallback: (from, to) => falls.push([from, to]),
      },
    });
    await router.updateWaitpoint({ where: { id: "cuid_w1" }, data: {} } as never);
    expect(falls).toEqual([["legacy", "new"]]);
  });

  it("lets a gen-2 waitpoint id beat the cross-tree legacy pin", async () => {
    const { router, log } = buildNShardRouter(["a", "b"]);
    const store = await router.forWaitpointCompletion("b:w1", {
      isCrossTreeIdempotency: true,
    } as never);
    expect((store as FakeStore).slot).toBe("b");
    expect(log.map((c) => c.slot)).not.toContain("legacy");
  });

  it("keeps the legacy pin for a cuid waitpoint in a cross-tree completion", async () => {
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log),
      legacy: fakeStore("legacy", log, { waitpoint: { id: "cuid_w1" } }),
      shards: [{ key: "a", store: fakeStore("a", log) }],
      resolveShard: (id: string) => (id.includes(":") ? id.split(":")[0]! : "legacy"),
    });
    const store = await router.forWaitpointCompletion("cuid_w1", {
      isCrossTreeIdempotency: true,
    } as never);
    expect((store as FakeStore).slot).toBe("legacy");
    expect(log.map((c) => c.slot)).not.toContain("a");
  });
});

describe("RoutingRunStore gen-2 shard refuses a co-located cuid waitpoint", () => {
  // resolveShard: "x:..." -> "x" (gen-2 shard); a bare id (no colon) -> "legacy".
  function coLocateRouter() {
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log),
      legacy: fakeStore("legacy", log),
      shards: [{ key: "a", store: fakeStore("a", log) }],
      resolveShard: (id: string) => (id.includes(":") ? id.split(":")[0]! : "legacy"),
    });
    return { router, log };
  }

  it("throws when a cuid waitpoint is co-located onto a gen-2 shard", () => {
    const { router, log } = coLocateRouter();
    // Routing throws SYNCHRONOUSLY, before any write is issued.
    expect(() =>
      router.createWaitpoint({ data: { id: "cuid_w1" } } as never, undefined, {
        coLocateWithRunId: "a:run_1",
      })
    ).toThrow("cuid-shaped waitpoint");
    expect(trace(log)).toEqual([]);
  });

  it("allows a gen-2 waitpoint co-located onto its own shard", async () => {
    const { router, log } = coLocateRouter();
    await router.createWaitpoint({ data: { id: "a:w1" } } as never, undefined, {
      coLocateWithRunId: "a:run_1",
    });
    expect(trace(log)).toEqual(["a:createWaitpoint"]);
  });

  it("allows a cuid waitpoint co-located onto a gen-1 store", async () => {
    const { router, log } = coLocateRouter();
    await router.createWaitpoint({ data: { id: "cuid_w1" } } as never, undefined, {
      coLocateWithRunId: "legacy_run",
    });
    expect(trace(log)).toEqual(["legacy:createWaitpoint"]);
  });
});

describe("RoutingRunStore id-less read/route defaults hold at N (never a gen-2 shard)", () => {
  // With gen-2 shards a and b configured, each id-less default must still resolve to its named
  // gen-1 store, never leak to a gen-2 shard.
  it("#routeOrNew falls back to new for an id-less create", async () => {
    const { router, log } = buildNShardRouter(["a", "b"]);
    await router.createRun({ data: {} } as never);
    expect(trace(log)).toEqual(["new:createRun"]);
  });

  it("#routeOrNew falls back to new for an id-less runInTransaction", async () => {
    const { router, log } = buildNShardRouter(["a", "b"]);
    await router.runInTransaction(undefined, async () => undefined);
    expect(trace(log)).toEqual(["new:runInTransaction"]);
  });

  it("#resolveWaitpointStore(undefined) falls back to legacy for an id-less update", async () => {
    const { router, log } = buildNShardRouter(["a", "b"]);
    await router.updateWaitpoint({ where: { idempotencyKey: "k" }, data: {} } as never);
    expect(trace(log)).toEqual(["legacy:updateWaitpoint"]);
  });

  it("#waitpointWriteStore with no owner and no residency falls back to legacy", async () => {
    const { router, log } = buildNShardRouter(["a", "b"]);
    await router.createWaitpoint({ data: {} } as never);
    expect(trace(log)).toEqual(["legacy:createWaitpoint"]);
  });
});
