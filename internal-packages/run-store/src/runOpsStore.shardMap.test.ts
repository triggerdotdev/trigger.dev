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

  it("routes an id-less checkpoint create to new (#idlessRouteShard)", async () => {
    const { router, log } = buildRouter();
    await router.createTaskRunCheckpoint({ data: {} } as never);
    expect(trace(log)).toEqual(["new:createTaskRunCheckpoint"]);
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
    expect(log.map((c) => c.slot).sort()).toEqual(["a", "b", "legacy", "new"]);
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
      metrics: { recordDuplicateId: (k: string[]) => seen.push(k), recordWaitpointProbeFallback() {} },
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
