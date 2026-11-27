import { generateRunOpsIdV2, mintWaitpointIdFor } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, it } from "vitest";
import {
  MEMORYDB_SHARD_KEY,
  RoutingRunStore,
  UnknownShardKey,
  type MemoryDbGate,
} from "./runOpsStore.js";
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
  // Batch row this store returns from findBatchTaskRunById, regardless of filter.
  batch?: Record<string, unknown> | null;
  // Waitpoint rows this store returns from findWaitpoint, regardless of filter.
  waitpoint?: Record<string, unknown> | null;
  // Rows this store returns from findRunsByIdempotencyKeys, regardless of filter.
  idempotencyMatches?: Array<Record<string, unknown>>;
  // Waitpoint ids this store reports as pending (present = pending here) for count/collect probes.
  pendingWaitpointIds?: string[];
  // Rows the methods below return, regardless of filter.
  attempt?: Record<string, unknown> | null;
  snapshots?: Array<Record<string, unknown>>;
  snapshotWaitpointIds?: string[];
  connectedRunIds?: string[];
  waitpoints?: Array<Record<string, unknown>>;
  tags?: Array<Record<string, unknown>>;
  // The count clearIdempotencyKey answers (default 1), and the count of the other bulk writes.
  clearCount?: number;
  writeCount?: number;
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

    clearIdempotencyKey: ((_params: unknown) => {
      record("clearIdempotencyKey");
      return Promise.resolve({ count: config.clearCount ?? 1 } as never);
    }) as FakeStore["clearIdempotencyKey"],

    findRunsByIdempotencyKeys: ((_args: unknown, _client?: ReadClient) => {
      record("findRunsByIdempotencyKeys");
      return Promise.resolve((config.idempotencyMatches ?? []) as never);
    }) as FakeStore["findRunsByIdempotencyKeys"],

    findBatchTaskRunById: ((_id: unknown, _args?: unknown, _client?: ReadClient) => {
      record("findBatchTaskRunById");
      return Promise.resolve((config.batch ?? null) as never);
    }) as FakeStore["findBatchTaskRunById"],

    upsertWaitpoint: ((args: { create?: { id?: string } }) => {
      record("upsertWaitpoint");
      return Promise.resolve((args.create ?? {}) as never);
    }) as FakeStore["upsertWaitpoint"],

    updateBatchTaskRun: ((_args: unknown) => {
      record("updateBatchTaskRun");
      return Promise.resolve({ slot } as never);
    }) as FakeStore["updateBatchTaskRun"],

    upsertWaitpointTag: ((data: { name: string }) => {
      record("upsertWaitpointTag");
      return Promise.resolve({ id: `tag_${slot}`, name: data.name } as never);
    }) as FakeStore["upsertWaitpointTag"],

    countPendingWaitpointsWithPresence: ((waitpointIds: string[], _client?: ReadClient) => {
      record("countPendingWaitpointsWithPresence");
      const pending = new Set(config.pendingWaitpointIds ?? []);
      const found = waitpointIds.filter((id) => pending.has(id));
      return Promise.resolve({ pendingIds: found, presentIds: found } as never);
    }) as FakeStore["countPendingWaitpointsWithPresence"],

    ...answering(record, {
      findTaskRunAttempt: () => config.attempt ?? null,
      findExecutionSnapshot: () => config.snapshots?.[0] ?? null,
      findManyExecutionSnapshots: () => config.snapshots ?? [],
      findSnapshotCompletedWaitpointIds: () => config.snapshotWaitpointIds ?? [],
      findSnapshotCompletedWaitpointIdsWithPresence: () => ({
        present: (config.snapshotWaitpointIds ?? []).length > 0,
        ids: config.snapshotWaitpointIds ?? [],
      }),
      findWaitpointConnectedRunIds: () => config.connectedRunIds ?? [],
      findManyWaitpoints: () => config.waitpoints ?? [],
      findManyWaitpointTags: () => config.tags ?? [],
      findBatchTaskRunByFriendlyId: () => config.batch ?? null,
      findBatchTaskRunByIdempotencyKey: () => config.batch ?? null,
      deleteManyTaskRunWaitpoints: () => ({ count: config.writeCount ?? 1 }),
      updateManyBatchTaskRun: () => ({ count: config.writeCount ?? 1 }),
      findWaitpointOnPrimary: () => config.waitpoint ?? null,
      expireRunsBatch: (runIds: string[]) => runIds.length,
    }),
  };

  return store as unknown as FakeStore;
}

// Fake methods that record their name and resolve with what `answers` gives for their arguments.
function answering(
  record: (method: string) => void,
  answers: Record<string, (...args: never[]) => unknown>
): Partial<FakeStore> {
  return Object.fromEntries(
    Object.entries(answers).map(([method, answer]) => [
      method,
      (...args: never[]) => {
        record(method);
        return Promise.resolve(answer(...args));
      },
    ])
  ) as Partial<FakeStore>;
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

  // The case above injects a resolver. This one does NOT: it uses the real `resolveShard`, which
  // the compat constructor defaults to. `resolveShard` is pure id-shape, so a gen-2 shaped id
  // names its shard char whatever the topology holds — the two-store compat router therefore
  // reaches this throw for any gen-2 id, with no shard configured anywhere.
  //
  // That matters beyond this class: these ids reach read routes as URL parameters, so whatever
  // sits above the router must translate this throw into a 4xx rather than let it surface as a
  // 5xx that any caller can induce.
  it("reaches the unconfigured-shard throw for a real gen-2 id, even on the compat pair", () => {
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log),
      legacy: fakeStore("legacy", log),
    });

    const genTwoId = `${"0".repeat(24)}a2`;

    expect(() => router.findRun({ id: genTwoId })).toThrow(
      'no store is configured for shard key "a"'
    );
    expect(trace(log)).toEqual([]);
  });

  // Typed, not a bare Error: the API boundary matches on it to answer 404 instead of 500, and
  // the operator needs the key and the configured set to tell a forged id from a dropped shard.
  it("throws a typed UnknownShardKey carrying the key and the configured set", () => {
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log),
      legacy: fakeStore("legacy", log),
    });

    let thrown: unknown;
    try {
      router.findRun({ id: `${"0".repeat(24)}a2` });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnknownShardKey);
    const error = thrown as UnknownShardKey;
    expect(error.name).toBe("UnknownShardKey");
    expect(error.shardKey).toBe("a");
    expect([...error.configured].sort()).toEqual(["legacy", "new"]);
  });

  it("still routes gen-1 shapes on the compat pair with the real resolver", () => {
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log),
      legacy: fakeStore("legacy", log),
    });

    router.findRun({ id: `${"0".repeat(24)}01` });
    router.findRun({ id: "c".repeat(25) });

    expect(trace(log)).toEqual(["new:findRun", "legacy:findRun"]);
  });
});

function buildNShardRouter(
  shardKeys: string[],
  opts: { aliasOf?: Record<string, string>; routed?: string[] } = {}
) {
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
    ...(opts.routed
      ? {
          metrics: {
            recordDuplicateId() {},
            recordWaitpointProbeFallback() {},
            recordShardRouted: (key: string) => opts.routed!.push(key),
          },
        }
      : {}),
  });
  return { router, log, byKey };
}

describe("RoutingRunStore #distinctStores — one entry per database", () => {
  // findRunsByIds reaches #fanOutPartitioned, the third unconfigured-shard guard. It must throw
  // the typed error too, or this read path answers 500 where the boundary would give a 404.
  it("throws a typed UnknownShardKey from the partitioned id fan-out", async () => {
    const { router } = buildNShardRouter(["a"]);

    await expect(router.findRunsByIds(["a:r1", "z:r2"])).rejects.toBeInstanceOf(UnknownShardKey);
  });

  it("routes an id to its gen-2 shard", async () => {
    const { router, log } = buildNShardRouter(["a", "b"]);
    await router.findRun({ id: "a:run_1" });
    expect(trace(log)).toEqual(["a:findRun"]);
  });

  // Per-shard routing was invisible from outside the process: nothing the router emitted carried
  // the shard it routed to, so a cohort ramp could only be inferred from the databases themselves.
  it("counts every routed operation against the shard it landed on", async () => {
    const routed: string[] = [];
    const { router } = buildNShardRouter(["a", "b"], { routed });

    await router.findRun({ id: "a:run_1" });
    await router.findRun({ id: "b:run_1" });
    await router.findRun({ id: "a:run_2" });

    expect(routed).toEqual(["a", "b", "a"]);
  });

  // The counter is read as per-shard traffic during a ramp, so a lookup that had to search
  // rather than route must not be attributed to whichever store answered.
  it("does not count an unrouted lookup that misses", async () => {
    const routed: string[] = [];
    const { router } = buildNShardRouter(["a", "b"], { routed });

    await router.findRun({ spanId: "nope" });

    expect(routed).toEqual([]);
  });

  it("does not count an id-less operation against the default store", async () => {
    const routed: string[] = [];
    const { router } = buildNShardRouter(["a", "b"], { routed });

    await router.findRun({ spanId: "s1" }, undefined);
    await router.runInTransaction(undefined, async () => undefined);

    expect(routed).toEqual([]);
  });

  it("does not count the legacy leg of an unrouted probe", async () => {
    const routed: string[] = [];
    const { router } = buildNShardRouter(["a", "b"], { routed });

    await router.findRunsByIdempotencyKeys({
      runtimeEnvironmentId: "env_1",
      taskIdentifier: "task",
      idempotencyKeys: ["k1"],
    });

    expect(routed).toEqual([]);
  });

  it("does not count anything before an operation is routed", async () => {
    const routed: string[] = [];
    buildNShardRouter(["a", "b"], { routed });

    // Constructing the router touches every configured store to build #distinctStores; that is
    // not traffic, and counting it would put a boot-time step in a per-shard traffic series.
    expect(routed).toEqual([]);
  });

  it("counts an aliased shard's database ONCE in a sum", async () => {
    // "a" aliases "new": two keys, one database.
    const { router, log } = buildNShardRouter(["a"], { aliasOf: { a: "new" } });
    const result = await router.clearIdempotencyKey({
      byPredicate: {
        idempotencyKey: "k1",
        taskIdentifier: "task",
        runtimeEnvironmentId: "env_1",
        residency: "LEGACY",
      },
    });
    expect(trace(log)).toEqual(["new:clearIdempotencyKey", "legacy:clearIdempotencyKey"]);
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

  it("rejects a shard key that reuses a reserved key (new/legacy)", () => {
    const log: Call[] = [];
    expect(
      () =>
        new RoutingRunStore({
          new: fakeStore("new", log),
          legacy: fakeStore("legacy", log),
          shards: [{ key: "new", store: fakeStore("shadow" as Slot, log) }],
        })
    ).toThrow("must be unique");
  });

  it("rejects a duplicate custom shard key", () => {
    const log: Call[] = [];
    expect(
      () =>
        new RoutingRunStore({
          new: fakeStore("new", log),
          legacy: fakeStore("legacy", log),
          shards: [
            { key: "a", store: fakeStore("a1" as Slot, log) },
            { key: "a", store: fakeStore("a2" as Slot, log) },
          ],
        })
    ).toThrow("must be unique");
  });

  it("rejects a self-alias (a -> a), which would drop its database from every fan-out", () => {
    const log: Call[] = [];
    expect(
      () =>
        new RoutingRunStore({
          new: fakeStore("new", log),
          legacy: fakeStore("legacy", log),
          shards: [{ key: "a", store: fakeStore("a" as Slot, log), aliasOf: "a" }],
        })
    ).toThrow("must name a non-aliased store");
  });

  it("rejects an alias chain (a -> b where b is itself aliased)", () => {
    const log: Call[] = [];
    expect(
      () =>
        new RoutingRunStore({
          new: fakeStore("new", log),
          legacy: fakeStore("legacy", log),
          shards: [
            { key: "a", store: fakeStore("a" as Slot, log), aliasOf: "b" },
            { key: "b", store: fakeStore("b" as Slot, log), aliasOf: "new" },
          ],
        })
    ).toThrow("must name a non-aliased store");
  });

  it("rejects an alias cycle (a -> b, b -> a), which would drop both databases", () => {
    const log: Call[] = [];
    expect(
      () =>
        new RoutingRunStore({
          new: fakeStore("new", log),
          legacy: fakeStore("legacy", log),
          shards: [
            { key: "a", store: fakeStore("a" as Slot, log), aliasOf: "b" },
            { key: "b", store: fakeStore("b" as Slot, log), aliasOf: "a" },
          ],
        })
    ).toThrow("must name a non-aliased store");
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

  // Catches: a two-store id-less look-up that asks the legacy store after the run-ops store failed.
  it("fails an id-less look-up at once on the first store's error at two stores", async () => {
    const { router, newStore, log } = buildRouter();
    (newStore as { findRun: unknown }).findRun = () => Promise.reject(new Error("new is down"));
    await expect(router.findRun({ spanId: "span_x" })).rejects.toThrow("new is down");
    expect(trace(log)).toEqual([]);
  });

  // Catches: a three-store id-less look-up that lets the legacy store's hit beat the run-ops store's.
  it("returns the run-ops store's hit over the legacy store's at three stores", async () => {
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log, { runs: [{ id: "r_new" }] }),
      legacy: fakeStore("legacy", log, { runs: [{ id: "r_legacy" }] }),
      shards: [{ key: "a", store: fakeStore("a", log) }],
      resolveShard: (id: string) => id.split(":")[0]!,
    });
    await expect(router.findRun({ spanId: "span_x" })).resolves.toEqual({ id: "r_new" });
  });

  // Catches: a sum over stores that swallows one store's error and returns a partial count.
  it("fails an id-less idempotency-key clear on any one store's error, at two and three stores", async () => {
    for (const [shards, failing] of [
      [[], "legacy"],
      [[], "new"],
      [["a"], "legacy"],
      [["a"], "a"],
    ] as const) {
      const { router, byKey } = buildNShardRouter([...shards]);
      (byKey[failing] as { clearIdempotencyKey: unknown }).clearIdempotencyKey = () =>
        Promise.reject(new Error(`${failing} is down`));
      await expect(
        router.clearIdempotencyKey({
          byPredicate: { runtimeEnvironmentId: "env_1", idempotencyKey: "k" },
        } as never)
      ).rejects.toThrow(`${failing} is down`);
    }
  });

  // Catches: an open gate failing unlike base on a down store under m, or a closed gate asking it.
  it("treats a failing store under m as base treats a failing shard, and never asks it when closed", async () => {
    const outcome = (promise: Promise<unknown>) =>
      promise.then(
        (value) => ({ value }),
        (error: Error) => ({ error: error.message })
      );
    // Every method of the store under m rejects.
    const failing = (log: Call[], slot: Slot) =>
      new Proxy(
        {},
        {
          get: (_t, prop) =>
            prop === "then"
              ? undefined
              : () => {
                  log.push({ slot, method: String(prop) });
                  return Promise.reject(new Error("the store under m is down"));
                },
        }
      ) as unknown as RunStore;
    const calls: Array<[string, (r: RoutingRunStore) => Promise<unknown>]> = [
      ["findRun by a predicate", (r) => r.findRun({ spanId: "span_x" })],
      ["findRuns over every store", (r) => r.findRuns({ where: { spanId: "span_x" } } as never)],
      [
        "clearIdempotencyKey by predicate",
        (r) =>
          r.clearIdempotencyKey({
            byPredicate: { runtimeEnvironmentId: "env_1", idempotencyKey: "k" },
          } as never),
      ],
    ];
    const router = (
      matching: boolean,
      under: "m" | "b" | "none",
      gate: MemoryDbGate | undefined,
      log: Call[]
    ) => {
      const config = matching ? { runs: [{ id: "r1" }], clearCount: 1 } : { clearCount: 0 };
      return new RoutingRunStore({
        new: fakeStore("new", log, config),
        legacy: fakeStore("legacy", log, { clearCount: 0 }),
        shards: [
          { key: "a", store: fakeStore("a", log, { clearCount: 0 }) },
          ...(under === "none"
            ? []
            : [{ key: under === "m" ? MEMORYDB_SHARD_KEY : "b", store: failing(log, under) }]),
        ],
        resolveShard: (id: string) => id.split(":")[0]!,
        ...(gate ? { memoryDbGate: gate } : {}),
      });
    };
    for (const matching of [true, false]) {
      for (const [name, call] of calls) {
        const open = await outcome(call(router(matching, "m", countingGate([], true, false), [])));
        const base = await outcome(call(router(matching, "b", undefined, [])));
        expect({ name, matching, open }).toEqual({ name, matching, open: base });
        // A rejection is the store's own error, not one of the fan-out's. findRuns and the clear
        // by predicate always ask every store, so they must reject.
        if (
          "error" in open ||
          ["findRuns over every store", "clearIdempotencyKey by predicate"].includes(name)
        ) {
          expect({ name, matching, open }).toEqual({
            name,
            matching,
            open: { error: "the store under m is down" },
          });
        }

        const log: Call[] = [];
        const closed = await outcome(
          call(router(matching, "m", countingGate([], false, false), log))
        );
        const without = await outcome(call(router(matching, "none", undefined, [])));
        expect({ name, matching, closed, askedM: log.some((c) => c.slot === "m") }).toEqual({
          name,
          matching,
          closed: without,
          askedM: false,
        });
      }
    }
  });
});

describe("RoutingRunStore merge precedence and duplicate alarm", () => {
  const spy = () => {
    const seen: string[][] = [];
    return {
      metrics: {
        recordDuplicateId: (k: string[]) => seen.push(k),
        recordWaitpointProbeFallback() {},
        recordShardRouted() {},
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
      ...(spy
        ? {
            metrics: {
              recordDuplicateId: spy,
              recordWaitpointProbeFallback() {},
              recordShardRouted() {},
            },
          }
        : {}),
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

  // The API boundary answers a non-retryable 404 by matching on the TYPE, so every
  // unconfigured-shard guard has to throw the typed error and not a bare Error. Two other guards
  // besides #shardStore reach an unconfigured key: this partition, and #fanOutPartitioned below.
  it("throws a typed UnknownShardKey from the absent-id partition", async () => {
    const { router } = partitionRouter({});

    await expect(
      router.countPendingWaitpoints(["c:w1"], undefined, "a:run")
    ).rejects.toBeInstanceOf(UnknownShardKey);
  });

  it("returns zero for an id absent everywhere", async () => {
    const { router } = partitionRouter({});
    expect(await router.countPendingWaitpoints(["b:w9"], undefined, "a:run")).toBe(0);
  });

  it("id-less count unions a drain-mirrored cuid to one, never sums it to two", async () => {
    // No runId: fans over distinct stores. A cuid pending on BOTH gen-1 stores is one waitpoint.
    const { router } = partitionRouter({ new: ["cuid_w1"], legacy: ["cuid_w1"] });
    expect(await router.countPendingWaitpoints(["cuid_w1"])).toBe(1);
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
        recordShardRouted() {},
      },
    });
    await router.updateWaitpoint({ where: { id: "cuid_w1" }, data: {} } as never);
    expect(falls).toEqual([["legacy", "new"]]);
  });

  // Catches: a waitpoint write or tag upsert naming an unconfigured shard that lands on another store.
  it("raises UnknownShardKey for a waitpoint write or tag naming an unconfigured shard, reaching no store", async () => {
    const { router, log } = buildNShardRouter(["a"]);
    const tag = { environmentId: "env_1", name: "tag", projectId: "proj_1" };

    await expect(
      router.updateWaitpoint({ where: { id: "z:w1" }, data: {} } as never)
    ).rejects.toBeInstanceOf(UnknownShardKey);
    // createWaitpoint and upsertWaitpointTag are not async: they throw before returning a promise.
    expect(() => router.createWaitpoint({ data: { id: "z:w1" } } as never)).toThrow(
      UnknownShardKey
    );
    expect(() =>
      router.createWaitpoint({ data: { id: "z:w1", completedByTaskRunId: "z:run_1" } } as never)
    ).toThrow(UnknownShardKey);
    expect(() => router.upsertWaitpointTag(tag as never, undefined, "NEW", "z")).toThrow(
      UnknownShardKey
    );
    expect(trace(log)).toEqual([]);
  });

  // Catches: the shard look-up moving ahead of the co-location check for an id-less owned create.
  it("throws the plain co-location error, not UnknownShardKey, for an id-less create owned on an unconfigured shard", () => {
    const { router, log } = buildNShardRouter(["a"]);
    let thrown: unknown;
    try {
      router.createWaitpoint({ data: { completedByTaskRunId: "z:run_1" } } as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UnknownShardKey);
    expect((thrown as Error).message).toContain("refusing to co-locate waitpoint");
    expect(trace(log)).toEqual([]);
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
    ).toThrow('onto gen-2 shard "a"');
    expect(trace(log)).toEqual([]);
  });

  it("throws when an id-less waitpoint is co-located onto a gen-2 shard", () => {
    // Prisma's @default(cuid()) would otherwise mint a cuid on the gen-2 shard AFTER the write,
    // leaving it unroutable for its own completion (CodeRabbit finding). Reject it up front.
    const { router, log } = coLocateRouter();
    expect(() =>
      router.createWaitpoint({ data: {} } as never, undefined, { coLocateWithRunId: "a:run_1" })
    ).toThrow('onto gen-2 shard "a"');
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

  // Catches: a waitpoint whose id names configured shard b written beside its owner on shard a.
  it("refuses a create or upsert owned on shard a whose id names configured shard b", () => {
    const { router, log } = buildNShardRouter(["a", "b"]);
    expect(() =>
      router.createWaitpoint({ data: { id: "b:w1", completedByTaskRunId: "a:run_1" } } as never)
    ).toThrow("refusing to co-locate waitpoint");
    expect(() =>
      router.upsertWaitpoint(
        { create: { id: "b:w1" }, update: {}, where: { id: "b:w1" } } as never,
        undefined,
        { coLocateWithRunId: "a:run_1" }
      )
    ).toThrow("refusing to co-locate waitpoint");
    expect(trace(log)).toEqual([]);
  });

  // Catches: a create or upsert by a legacy id that probes the run-ops store first.
  it("sends a create or upsert by a legacy id with no owner or residency to legacy alone", async () => {
    const { router, log } = coLocateRouter();
    await router.createWaitpoint({ data: { id: "cuid_w1" } } as never);
    await router.upsertWaitpoint({
      create: { id: "cuid_w2" },
      update: {},
      where: { id: "cuid_w2" },
    } as never);
    expect(trace(log)).toEqual(["legacy:createWaitpoint", "legacy:upsertWaitpoint"]);
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

  // Catches: an id-less waitpoint upsert or batch update whose default store changes.
  it("sends an id-less waitpoint upsert to legacy and an id-less batch update to new, at two and three stores", async () => {
    for (const shards of [[], ["a"]]) {
      const { router, log } = buildNShardRouter(shards);
      await router.upsertWaitpoint({
        create: {},
        update: {},
        where: { idempotencyKey: "k" },
      } as never);
      await router.updateBatchTaskRun({
        where: { runtimeEnvironmentId: "env_1" },
        data: {},
        select: { id: true },
      } as never);
      expect(trace(log)).toEqual(["legacy:upsertWaitpoint", "new:updateBatchTaskRun"]);
    }
  });
});

describe("RoutingRunStore batch probe tolerates legitimate dual-residency", () => {
  it("does NOT alarm when a batch is found on a gen-2 shard AND legacy", async () => {
    const seen: string[][] = [];
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log),
      legacy: fakeStore("legacy", log, { batch: { id: "batch_dup", from: "legacy" } }),
      shards: [{ key: "a", store: fakeStore("a", log, { batch: { id: "batch_dup", from: "a" } }) }],
      resolveShard: (id: string) => id.split(":")[0]!,
      metrics: {
        recordDuplicateId: (k) => seen.push(k),
        recordWaitpointProbeFallback() {},
        recordShardRouted() {},
      },
    });
    const batch = (await router.findBatchTaskRunById("batch_dup")) as { from: string } | null;
    // batchTriggerV3 writes raw to the control plane while runEngine routes by id, so this is a
    // legitimate dual-residency, not a routing-invariant violation — no alarm.
    expect(seen).toEqual([]);
    // Precedence still picks deterministically (gen-2 shard 'a' outranks legacy).
    expect(batch?.from).toBe("a");
  });

  it("still alarms when a RUN is found on a gen-2 shard AND legacy (real violation)", async () => {
    const seen: string[][] = [];
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log),
      legacy: fakeStore("legacy", log, { runs: [{ id: "dup", from: "legacy" }] }),
      shards: [{ key: "a", store: fakeStore("a", log, { runs: [{ id: "dup", from: "a" }] }) }],
      resolveShard: (id: string) => id.split(":")[0]!,
      metrics: {
        recordDuplicateId: (k) => seen.push(k),
        recordWaitpointProbeFallback() {},
        recordShardRouted() {},
      },
    });
    await router.findRun({ spanId: "span_x" });
    expect(seen).toEqual([["legacy", "a"]]);
  });
});

describe("RoutingRunStore waitpoint tags follow their environment's shard", () => {
  const tag = { environmentId: "env_1", name: "tag", projectId: "proj_1" };

  const shardedRouter = () => {
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log),
      legacy: fakeStore("legacy", log),
      shards: [{ key: "a", store: fakeStore("a", log) }],
    });
    return { router, log };
  };

  it("routes a tag to the gen-2 shard the environment mints on", async () => {
    const { router, log } = shardedRouter();
    await router.upsertWaitpointTag(tag as never, undefined, "NEW", "a");
    expect(trace(log)).toEqual(["a:upsertWaitpointTag"]);
  });

  it("a gen-1 shard key still routes by residency", async () => {
    const { router, log } = shardedRouter();
    await router.upsertWaitpointTag(tag as never, undefined, "NEW", "new");
    expect(trace(log)).toEqual(["new:upsertWaitpointTag"]);
  });

  it("no shard hint keeps today's behaviour exactly", async () => {
    const { router, log } = shardedRouter();
    await router.upsertWaitpointTag(tag as never, undefined, "LEGACY");
    expect(trace(log)).toEqual(["legacy:upsertWaitpointTag"]);
  });
});

describe("RoutingRunStore waitpoint writes: a stamped gen-2 id outranks a residency hint", () => {
  // A caller passing both used to write to a gen-1 database silently: a create never misses.
  const GEN2 = `${"a".repeat(24)}a2`;
  const GEN1 = `${"a".repeat(24)}01`;
  const CUID = "c".repeat(25);

  const shardedRouter = () => {
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log),
      legacy: fakeStore("legacy", log),
      shards: [{ key: "a", store: fakeStore("a", log) }],
    });
    return { router, log };
  };

  const upsert = (router: RoutingRunStore, id: string, residency?: "NEW" | "LEGACY") =>
    router.upsertWaitpoint(
      { create: { id }, update: {}, where: { id } } as never,
      undefined,
      residency === undefined ? undefined : ({ residency } as never)
    );

  it("routes to the shard the id names even when the hint says NEW", async () => {
    const { router, log } = shardedRouter();
    await upsert(router, GEN2, "NEW");
    expect(trace(log)).toEqual(["a:upsertWaitpoint"]);
  });

  it("routes to the shard the id names even when the hint says LEGACY", async () => {
    const { router, log } = shardedRouter();
    await upsert(router, GEN2, "LEGACY");
    expect(trace(log)).toEqual(["a:upsertWaitpoint"]);
  });

  it("still honours the hint for a gen-1 run-ops id, which the hint can express", async () => {
    const { router, log } = shardedRouter();
    await upsert(router, GEN1, "NEW");
    expect(trace(log)).toEqual(["new:upsertWaitpoint"]);
  });

  it("still honours the hint for a cuid, and does not read it as a shard", async () => {
    const { router, log } = shardedRouter();
    await upsert(router, CUID, "NEW");
    expect(trace(log)).toEqual(["new:upsertWaitpoint"]);
  });

  it("with no hint at all, a gen-1 id still routes by its own shape", async () => {
    const { router, log } = shardedRouter();
    await upsert(router, GEN1);
    expect(trace(log)).toEqual(["new:upsertWaitpoint"]);
  });

  it("an owning run still outranks both, so a co-located waitpoint follows its run", async () => {
    const { router, log } = shardedRouter();
    await router.upsertWaitpoint(
      { create: { id: GEN2 }, update: {}, where: { id: GEN2 } } as never,
      undefined,
      { coLocateWithRunId: GEN2, residency: "NEW" } as never
    );
    expect(trace(log)).toEqual(["a:upsertWaitpoint"]);
  });
});

// One operation per id-routing path of the router, each carrying `id` as its routing id.
function idRoutedOperations(router: RoutingRunStore, id: string) {
  return {
    findRun: () => router.findRun({ id }),
    createRun: () => router.createRun({ data: { id } } as never),
    createTaskRunCheckpoint: () => router.createTaskRunCheckpoint({ data: {} } as never, id),
    findRuns: () => router.findRuns({ where: { id: { in: [id] } } }),
    createWaitpoint: () =>
      router.createWaitpoint({ data: { ...mintWaitpointIdFor(id) } } as never, undefined, {
        coLocateWithRunId: id,
      }),
    updateBatchTaskRun: () =>
      router.updateBatchTaskRun({ where: { id }, data: {}, select: { id: true } }),
  };
}

// Catches a sync throw and an async rejection alike: some routing methods throw before any promise.
async function outcome(call: () => unknown): Promise<unknown> {
  try {
    await call();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("the MemoryDB key routes like any other shard key", () => {
  // Catches: a generation 3 id reaching a Postgres store instead of the store registered under m.
  it("sends every id-routed operation with a generation 3 id to the store under m", async () => {
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log),
      legacy: fakeStore("legacy", log),
      shards: [
        { key: "a", store: fakeStore("a", log) },
        { key: MEMORYDB_SHARD_KEY, store: fakeStore("m", log) },
      ],
    });

    const runId = generateRunOpsIdV2(MEMORYDB_SHARD_KEY);
    const batchId = generateRunOpsIdV2(MEMORYDB_SHARD_KEY);
    const ops = {
      ...idRoutedOperations(router, runId),
      updateBatchTaskRun: idRoutedOperations(router, batchId).updateBatchTaskRun,
    };
    for (const [name, call] of Object.entries(ops)) {
      log.length = 0;
      expect({ name, error: await outcome(call) }).toEqual({ name, error: undefined });
      expect({ name, calls: trace(log) }).toEqual({ name, calls: [`m:${name}`] });
    }

    log.length = 0;
    await router.findRun({ id: "clh4abcdefghijklmnopqrstu" });
    await router.findRun({ id: `${"a".repeat(24)}01` });
    await router.findRun({ id: generateRunOpsIdV2("a") });
    expect(trace(log)).toEqual(["legacy:findRun", "new:findRun", "a:findRun"]);
  });

  // Catches: an id naming m being answered differently from an id naming any unconfigured key.
  it("with no store under m, answers a generation 3 id as it answers any unconfigured key", async () => {
    const log: Call[] = [];
    const router = new RoutingRunStore({
      new: fakeStore("new", log),
      legacy: fakeStore("legacy", log),
      shards: [{ key: "a", store: fakeStore("a", log) }],
    });

    const memoryDbId = generateRunOpsIdV2(MEMORYDB_SHARD_KEY);
    const unconfiguredId = generateRunOpsIdV2("z");
    const memoryDbOps = idRoutedOperations(router, memoryDbId);
    const unconfiguredOps = idRoutedOperations(router, unconfiguredId);

    for (const name of Object.keys(memoryDbOps) as Array<keyof typeof memoryDbOps>) {
      const onM = await outcome(memoryDbOps[name]);
      const onZ = await outcome(unconfiguredOps[name]);

      expect(onM).toBeInstanceOf(UnknownShardKey);
      expect(onZ).toBeInstanceOf(UnknownShardKey);
      expect({ name, key: (onM as UnknownShardKey).shardKey }).toEqual({ name, key: "m" });
      expect({ name, key: (onZ as UnknownShardKey).shardKey }).toEqual({ name, key: "z" });
      expect({
        name,
        message: (onM as Error).message.replaceAll(memoryDbId, "<id>").replace('"m"', '"<key>"'),
      }).toEqual({
        name,
        message: (onZ as Error).message
          .replaceAll(unconfiguredId, "<id>")
          .replace('"z"', '"<key>"'),
      });
    }
    expect(trace(log)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The gate on the store under m. Every id-less operation runs through one matrix, so a method added
// to it later is covered by adding one entry. The stand-in's slot is always "m", whatever key it is
// registered under, so a router with it under m compares directly with one with it under "b".
// ---------------------------------------------------------------------------------------------

const CUID = "clh4abcdefghijklmnopqrstu";
const GEN1 = `${"a".repeat(24)}01`;
const WAITPOINT_IDS = ["wp_1", "wp_new", "wp_legacy", "wp_a", "wp_m"];
// The stand-in's key-holder is created first, so it wins an idempotency-key tie-break by creation.
const CREATED: Record<Slot, Date> = {
  m: new Date("2026-01-01T00:00:00Z"),
  a: new Date("2026-01-02T00:00:00Z"),
  new: new Date("2026-01-03T00:00:00Z"),
  legacy: new Date("2026-01-04T00:00:00Z"),
  archive: new Date("2026-01-01T12:00:00Z"),
};

// Every store holds one row shared by id with the others and one of its own, for every method.
const holding = (slot: Slot): FakeConfig => ({
  runs: [
    { id: "run_dup", from: slot },
    { id: `run_${slot}`, from: slot },
  ],
  edges: [
    { id: "edge_dup", waitpointId: "wp_1", from: slot },
    { id: `edge_${slot}`, waitpointId: "wp_1", from: slot },
  ],
  batch: { id: `batch_${slot}`, from: slot },
  waitpoint: { id: `wp_${slot}`, from: slot },
  waitpoints: [
    { id: "wp_1", from: slot },
    { id: `wp_${slot}`, from: slot },
  ],
  idempotencyMatches: [
    { id: `run_${slot}`, idempotencyKey: "key_1", createdAt: CREATED[slot], from: slot },
  ],
  pendingWaitpointIds: ["wp_1", `wp_${slot}`],
  attempt: { id: `attempt_${slot}`, from: slot },
  snapshots: [{ id: `snapshot_${slot}`, from: slot }],
  snapshotWaitpointIds: ["wp_1", `wp_${slot}`],
  connectedRunIds: ["run_1", `run_${slot}`],
  tags: [{ id: `tag_${slot}`, environmentId: "env_1", name: `tag_${slot}`, from: slot }],
});

type Where = Record<string, unknown>;
type Entry = {
  name: string;
  // Makes the call; `where` is merged into the predicate of an entry that has one.
  call: (router: RoutingRunStore, where?: Where) => unknown;
  // A predicate key the routing does not route by, for the generation 3 id forms.
  gen3Key?: string;
  config?: Partial<Record<Slot, FakeConfig>>;
  // Calls the operation makes before it asks the gate.
  beforeGate?: string[];
};

const PREDICATE = {
  idempotencyKey: "key_1",
  taskIdentifier: "task",
  runtimeEnvironmentId: "env_1",
};

const matrix: Entry[] = [
  { name: "findRun", gen3Key: "parentTaskRunId", call: (r, w) => r.findRun({ spanId: "s", ...w }) },
  {
    name: "findRunOnPrimary",
    gen3Key: "parentTaskRunId",
    call: (r, w) => r.findRunOnPrimary({ spanId: "s", ...w }),
  },
  {
    name: "findRunOrThrow",
    gen3Key: "parentTaskRunId",
    call: (r, w) => r.findRunOrThrow({ spanId: "s", ...w }),
  },
  {
    name: "findRuns open",
    gen3Key: "parentTaskRunId",
    call: (r, w) => r.findRuns({ where: { status: "PENDING", ...w } }),
  },
  {
    name: "findRunsByIdempotencyKeys",
    call: (r) =>
      r.findRunsByIdempotencyKeys({
        runtimeEnvironmentId: "env_1",
        taskIdentifier: "task",
        idempotencyKeys: ["key_1"],
      }),
  },
  {
    name: "findTaskRunAttempt",
    gen3Key: "friendlyId",
    call: (r, w) => r.findTaskRunAttempt({ where: { status: "EXECUTING", ...w } } as never),
  },
  {
    name: "findExecutionSnapshot",
    gen3Key: "batchId",
    call: (r, w) => r.findExecutionSnapshot({ where: { id: "snapshot_1", ...w } } as never),
  },
  {
    name: "findManyExecutionSnapshots",
    gen3Key: "batchId",
    call: (r, w) => r.findManyExecutionSnapshots({ where: { id: "snapshot_1", ...w } } as never),
  },
  {
    name: "findSnapshotCompletedWaitpointIds",
    call: (r) => r.findSnapshotCompletedWaitpointIds("snapshot_1"),
  },
  {
    name: "findSnapshotCompletedWaitpointIdsWithPresence",
    call: (r) => r.findSnapshotCompletedWaitpointIdsWithPresence("snapshot_1"),
  },
  {
    name: "findManyTaskRunWaitpoints",
    gen3Key: "batchId",
    call: (r, w) => r.findManyTaskRunWaitpoints({ where: { waitpointId: "wp_1", ...w } } as never),
  },
  { name: "findWaitpointConnectedRunIds", call: (r) => r.findWaitpointConnectedRunIds("wp_1") },
  {
    name: "findManyWaitpoints",
    gen3Key: "completedByTaskRunId",
    call: (r, w) => r.findManyWaitpoints({ where: { environmentId: "env_1", ...w } } as never),
  },
  {
    name: "findWaitpoint",
    gen3Key: "completedByTaskRunId",
    call: (r, w) => r.findWaitpoint({ where: { idempotencyKey: "key_1", ...w } } as never),
  },
  { name: "countPendingWaitpoints", call: (r) => r.countPendingWaitpoints(WAITPOINT_IDS) },
  {
    name: "countPendingWaitpointsWithPresence",
    call: (r) => r.countPendingWaitpointsWithPresence(WAITPOINT_IDS),
  },
  {
    name: "findManyWaitpointTags",
    gen3Key: "projectId",
    call: (r, w) => r.findManyWaitpointTags({ where: { environmentId: "env_1", ...w } }),
  },
  { name: "findBatchTaskRunById", call: (r) => r.findBatchTaskRunById("batch_1") },
  {
    name: "findBatchTaskRunByFriendlyId",
    call: (r) => r.findBatchTaskRunByFriendlyId("batch_1", "env_1"),
  },
  {
    name: "findBatchTaskRunByIdempotencyKey",
    call: (r) => r.findBatchTaskRunByIdempotencyKey("env_1", "key_1"),
  },
  {
    name: "clearIdempotencyKey byPredicate NEW",
    call: (r) => r.clearIdempotencyKey({ byPredicate: { ...PREDICATE, residency: "NEW" } }),
    config: { new: { clearCount: 0 } },
    beforeGate: ["new:clearIdempotencyKey"],
  },
  {
    name: "clearIdempotencyKey byPredicate",
    call: (r) => r.clearIdempotencyKey({ byPredicate: PREDICATE }),
  },
  {
    name: "clearIdempotencyKey byFriendlyIds",
    call: (r) => r.clearIdempotencyKey({ byFriendlyIds: ["run_1"] } as never),
  },
  {
    name: "deleteManyTaskRunWaitpoints",
    gen3Key: "batchId",
    call: (r, w) => r.deleteManyTaskRunWaitpoints({ where: { waitpointId: "wp_1", ...w } }),
  },
  {
    name: "updateManyBatchTaskRun",
    gen3Key: "friendlyId",
    call: (r, w) => r.updateManyBatchTaskRun({ where: { status: "PENDING", ...w }, data: {} }),
  },
];

// The operations whose id arguments item 2 reads, each with a generation 3 id.
const gen3IdArguments = (id: string): Entry[] => [
  { name: "findBatchTaskRunById by id", call: (r) => r.findBatchTaskRunById(id) },
  {
    name: "findBatchTaskRunByFriendlyId by friendly id",
    call: (r) => r.findBatchTaskRunByFriendlyId(`batch_${id}`, "env_1"),
  },
  {
    name: "findManyWaitpoints by run id, no id list",
    call: (r) =>
      r.findManyWaitpoints({ where: { environmentId: "env_1" } } as never, undefined, id),
  },
  {
    name: "clearIdempotencyKey by friendly ids",
    call: (r) => r.clearIdempotencyKey({ byFriendlyIds: [`run_${id}`] } as never),
  },
];

// A gate that records each question and answers as the case says.
function countingGate(
  calls: string[],
  bornHere: boolean,
  organizationOpens: boolean | Error,
  archiveFlagsOn: boolean | Error = false
): MemoryDbGate {
  return {
    bornHere: () => {
      calls.push("bornHere");
      return bornHere;
    },
    organizationOpens: () => {
      calls.push("organizationOpens");
      return organizationOpens instanceof Error
        ? Promise.reject(organizationOpens)
        : Promise.resolve(organizationOpens);
    },
    archiveFlagsOn: () => {
      calls.push("archiveFlagsOn");
      return archiveFlagsOn instanceof Error
        ? Promise.reject(archiveFlagsOn)
        : Promise.resolve(archiveFlagsOn);
    },
  };
}

// Every method call on `store` is recorded as usual, then rejects.
function failing(store: FakeStore): FakeStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        Promise.resolve(value.apply(target, args)).then(() => {
          throw new Error(`${target.slot} failed`);
        });
    },
  });
}

type Shape = {
  three: boolean;
  // The key the stand-in is registered under; none when absent.
  standIn?: "m" | "b";
  // The archive stand-in (slot "archive"): the `archive` option, or a generation 2 shard keyed "z".
  archive?: "option" | "shard";
  gate?: MemoryDbGate;
  failingSlot?: Slot;
  config?: Partial<Record<Slot, FakeConfig>>;
};

function gatedRouter(shape: Shape) {
  const log: Call[] = [];
  const make = (slot: Slot) => {
    const store = fakeStore(slot, log, { ...holding(slot), ...shape.config?.[slot] });
    return slot === shape.failingSlot ? failing(store) : store;
  };
  const shards: Array<{ key: string; store: RunStore }> = [];
  if (shape.three) shards.push({ key: "a", store: make("a") });
  if (shape.archive === "shard") shards.push({ key: "z", store: make("archive") });
  if (shape.standIn) {
    shards.push({ key: shape.standIn === "m" ? MEMORYDB_SHARD_KEY : "b", store: make("m") });
  }
  const router = new RoutingRunStore({
    new: make("new"),
    legacy: make("legacy"),
    shards,
    memoryDbGate: shape.gate,
    archive: shape.archive === "option" ? make("archive") : undefined,
  });
  return { router, log };
}

async function settle(call: () => unknown): Promise<unknown> {
  try {
    return { value: await call() };
  } catch (error) {
    return { error: { name: (error as Error).name, message: (error as Error).message } };
  }
}

// The calls and the result of one entry: the ordered trace when `ordered`, else the slot multiset.
async function observe(entry: Entry, shape: Shape, where?: Where, ordered = !shape.three) {
  const { router, log } = gatedRouter({ ...shape, config: { ...entry.config, ...shape.config } });
  const result = await settle(() => entry.call(router, where));
  return { calls: ordered ? trace(log) : slots(log), result };
}

const closedGates = () => {
  const calls: string[] = [];
  return [
    { label: "no gate", gate: undefined, calls },
    { label: "a gate answering false", gate: countingGate(calls, false, false), calls },
  ];
};

describe("the gate on the store under m", () => {
  // Catches: a closed gate still asking the store under m, or changing the order, mode or result
  // of the stores asked on base.
  it("with the gate closed, asks the stores it asks without m, in the same order and mode", async () => {
    for (const three of [false, true]) {
      for (const failingSlot of [undefined, "new", "legacy", ...(three ? ["a"] : [])]) {
        for (const entry of matrix) {
          for (const { label, gate } of closedGates()) {
            const without = await observe(entry, { three, failingSlot });
            const withM = await observe(entry, { three, failingSlot, standIn: "m", gate });
            expect({ entry: entry.name, three, failingSlot, label, ...withM }).toEqual({
              entry: entry.name,
              three,
              failingSlot,
              label,
              ...without,
            });
          }
        }
      }
    }
  });

  // Catches: an open gate leaving the store under m out, or treating it unlike a generation 2 shard.
  it("with the gate open by the organisation, asks the store under m as one more store", async () => {
    for (const three of [false, true]) {
      for (const entry of matrix) {
        const gate = countingGate([], false, true);
        const withM = await observe(entry, { three, standIn: "m", gate }, undefined, false);
        const withB = await observe(entry, { three, standIn: "b" }, undefined, false);
        expect({ entry: entry.name, three, ...withM }).toEqual({
          entry: entry.name,
          three,
          ...withB,
        });
        expect({ entry: entry.name, asked: withM.calls.includes("m") }).toEqual({
          entry: entry.name,
          asked: true,
        });
      }
    }
  });

  // Catches: the conditions asked out of order, or a generation 3 id in the predicate not opening it.
  it("opens on a generation 3 id, then bornHere, then organizationOpens", async () => {
    const gen3 = generateRunOpsIdV2(MEMORYDB_SHARD_KEY);
    const asksM = async (entry: Entry, gate: MemoryDbGate | undefined, where?: Where) =>
      (await observe(entry, { three: false, standIn: "m", gate }, where, false)).calls.includes(
        "m"
      );

    for (const entry of matrix) {
      const calls: string[] = [];
      const opened = await asksM(entry, countingGate(calls, true, false));
      expect({ entry: entry.name, opened, calls }).toEqual({
        entry: entry.name,
        opened: true,
        calls: ["bornHere"],
      });
    }

    const forms = [gen3, { equals: gen3 }, { in: [CUID, gen3] }];
    const byPredicate = matrix.filter((entry) => entry.gen3Key !== undefined);
    const cases = [
      ...byPredicate.flatMap((entry) =>
        forms.map((form) => ({ entry, where: { [entry.gen3Key!]: form }, form }))
      ),
      ...gen3IdArguments(gen3).map((entry) => ({ entry, where: undefined, form: "argument" })),
      // The top-level `id` key itself, in a form the routing does not route by.
      ...matrix
        .filter((entry) => entry.name === "updateManyBatchTaskRun")
        .map((entry) => ({ entry, where: { id: { in: [CUID, gen3] } }, form: "id in" })),
    ];
    for (const { entry, where, form } of cases) {
      for (const gated of [true, false]) {
        const calls: string[] = [];
        const opened = await asksM(
          entry,
          gated ? countingGate(calls, false, false) : undefined,
          where
        );
        expect({ entry: entry.name, form, gated, opened, calls }).toEqual({
          entry: entry.name,
          form,
          gated,
          opened: true,
          calls: [],
        });
      }
    }

    // Nothing nested is read: a generation 3 id only inside OR leaves the gate closed.
    const openRuns = matrix.find((entry) => entry.name === "findRuns open")!;
    for (const gated of [true, false]) {
      const calls: string[] = [];
      const gate = gated ? countingGate(calls, false, false) : undefined;
      const opened = await asksM(openRuns, gate, { OR: [{ parentTaskRunId: gen3 }] });
      expect({ gated, opened, calls }).toEqual({
        gated,
        opened: false,
        calls: gated ? ["bornHere", "organizationOpens"] : [],
      });
    }
  });

  // Catches: the gate asked with no store under m, more than once per call, or where no leg list is read.
  it("asks the gate lazily and at most once per call", async () => {
    for (const three of [false, true]) {
      for (const entry of matrix) {
        const calls: string[] = [];
        const gated = await observe(entry, { three, gate: countingGate(calls, true, true) });
        const ungated = await observe(entry, { three });
        expect({ entry: entry.name, three, asked: calls, ...gated }).toEqual({
          entry: entry.name,
          three,
          asked: [],
          ...ungated,
        });
      }
    }

    const withRelation: Entry = {
      name: "findManyTaskRunWaitpoints with the waitpoint relation",
      call: (r) =>
        r.findManyTaskRunWaitpoints({
          where: { waitpointId: "wp_1" },
          include: { waitpoint: true },
        } as never),
    };
    for (const entry of [...matrix, withRelation]) {
      const calls: string[] = [];
      const { result } = await observe(entry, {
        three: false,
        standIn: "m",
        gate: countingGate(calls, false, false),
      });
      expect({ entry: entry.name, calls }).toEqual({
        entry: entry.name,
        calls: ["bornHere", "organizationOpens"],
      });
      expect(result).toHaveProperty("value");
    }

    const readsNoLegList: Entry[] = [
      {
        name: "clearIdempotencyKey NEW, cleared on the run-ops store",
        call: (r) => r.clearIdempotencyKey({ byPredicate: { ...PREDICATE, residency: "NEW" } }),
      },
      {
        name: "findManyWaitpoints by run id, every id found on the run's store",
        call: (r) =>
          r.findManyWaitpoints({ where: { id: { in: ["wp_1"] } } } as never, undefined, CUID),
      },
      {
        name: "findRunsByIdempotencyKeys with no keys",
        call: (r) =>
          r.findRunsByIdempotencyKeys({
            runtimeEnvironmentId: "env_1",
            taskIdentifier: "task",
            idempotencyKeys: [],
          }),
      },
      {
        name: "findManyTaskRunWaitpoints by a routable run id, no waitpoint relation",
        call: (r) => r.findManyTaskRunWaitpoints({ where: { taskRunId: CUID } } as never),
      },
      {
        name: "findManyTaskRunWaitpoints by a routable run id with the waitpoint relation, no edges",
        call: (r) =>
          r.findManyTaskRunWaitpoints({
            where: { taskRunId: CUID },
            include: { waitpoint: true },
          } as never),
        config: { legacy: { edges: [] } },
      },
    ];
    for (const entry of readsNoLegList) {
      const calls: string[] = [];
      await observe(entry, { three: false, standIn: "m", gate: countingGate(calls, true, true) });
      expect({ entry: entry.name, calls }).toEqual({ entry: entry.name, calls: [] });
    }
  });

  // Catches: the edge hydration deciding the gate again instead of taking the outer call's decision.
  it("hydrates an edge's waitpoint with the decision of the outer call", async () => {
    const gen3Run = generateRunOpsIdV2(MEMORYDB_SHARD_KEY);
    const onlyOnM = (rows: FakeConfig): Partial<Record<Slot, FakeConfig>> => ({
      new: { edges: [], waitpoints: [] },
      legacy: { edges: [], waitpoints: [] },
      m: rows,
    });
    const read = (taskRunIdOrWaitpointId: Where) => (r: RoutingRunStore) =>
      r.findManyTaskRunWaitpoints({
        where: taskRunIdOrWaitpointId,
        include: { waitpoint: true },
      } as never);

    let calls: string[] = [];
    let { router, log } = gatedRouter({
      three: false,
      standIn: "m",
      gate: countingGate(calls, false, false),
      config: onlyOnM({
        edges: [{ id: "edge_m", waitpointId: "wp_m" }],
        waitpoints: [{ id: "wp_m", status: "PENDING" }],
      }),
    });
    expect(await read({ taskRunId: gen3Run })(router)).toEqual([
      { id: "edge_m", waitpointId: "wp_m", waitpoint: { id: "wp_m", status: "PENDING" } },
    ]);
    // The edges come from m by the run id; the hydration then asks every store, m among them.
    expect({ calls, log: trace(log).sort() }).toEqual({
      calls: [],
      log: [
        "legacy:findManyWaitpoints",
        "m:findManyTaskRunWaitpoints",
        "m:findManyWaitpoints",
        "new:findManyWaitpoints",
      ],
    });

    calls = [];
    ({ router, log } = gatedRouter({
      three: false,
      standIn: "m",
      gate: countingGate(calls, false, false),
      config: {
        new: { edges: [{ id: "edge_new", waitpointId: "wp_new" }], waitpoints: [{ id: "wp_new" }] },
        legacy: { waitpoints: [] },
      },
    }));
    expect(await read({ taskRunId: GEN1 })(router)).toEqual([
      { id: "edge_new", waitpointId: "wp_new", waitpoint: { id: "wp_new" } },
    ]);
    expect(slots(log)).not.toContain("m");

    calls = [];
    ({ router, log } = gatedRouter({
      three: false,
      standIn: "m",
      gate: countingGate(calls, false, true),
      config: {
        new: { edges: [{ id: "edge_new", waitpointId: "wp_m" }], waitpoints: [] },
        legacy: { edges: [], waitpoints: [] },
        m: { edges: [], waitpoints: [{ id: "wp_m", status: "PENDING" }] },
      },
    }));
    expect(await read({ waitpointId: "wp_m" })(router)).toEqual([
      { id: "edge_new", waitpointId: "wp_m", waitpoint: { id: "wp_m", status: "PENDING" } },
    ]);
    expect(calls).toEqual(["bornHere", "organizationOpens"]);
  });

  // Catches: a rejected organizationOpens() swallowed, closing the gate, or followed by a store call.
  it("fails the operation with the rejection of organizationOpens, asking no store after it", async () => {
    for (const three of [false, true]) {
      for (const entry of matrix) {
        const rejection = new Error("organisation look-up failed");
        const { router, log } = gatedRouter({
          three,
          standIn: "m",
          gate: countingGate([], false, rejection),
          config: entry.config,
        });
        const error = await outcome(() => entry.call(router));
        expect({ entry: entry.name, three, same: error === rejection, calls: trace(log) }).toEqual({
          entry: entry.name,
          three,
          same: true,
          calls: entry.beforeGate ?? [],
        });
      }
    }
  });

  // Catches: the gate reaching a default-store operation or an id-carrying fall-back.
  it("leaves default-store operations and id-carrying fall-backs as they are", async () => {
    const defaults: Array<Entry & { store: string }> = [
      { name: "createRun", store: "new", call: (r) => r.createRun({ data: {} } as never) },
      {
        name: "runInTransaction",
        store: "new",
        call: (r) => r.runInTransaction(undefined, async () => undefined),
      },
      {
        name: "createWaitpoint",
        store: "legacy",
        call: (r) => r.createWaitpoint({ data: {} } as never),
      },
      {
        name: "upsertWaitpoint",
        store: "legacy",
        call: (r) =>
          r.upsertWaitpoint({ where: { idempotencyKey: "k" }, create: {}, update: {} } as never),
      },
      {
        name: "upsertWaitpointTag",
        store: "legacy",
        call: (r) => r.upsertWaitpointTag({ environmentId: "env_1", name: "t", projectId: "p" }),
      },
      {
        name: "updateWaitpoint",
        store: "legacy",
        call: (r) => r.updateWaitpoint({ where: { idempotencyKey: "k" }, data: {} } as never),
      },
      {
        name: "updateBatchTaskRun",
        store: "new",
        call: (r) => r.updateBatchTaskRun({ where: {}, data: {}, select: { id: true } } as never),
      },
      {
        name: "findWaitpointOnPrimary",
        store: "new",
        call: (r) => r.findWaitpointOnPrimary({ where: { idempotencyKey: "k" } } as never),
      },
    ];
    const fallBacks: Entry[] = [
      {
        name: "countPendingWaitpoints by run id, a cuid missing on the run's store",
        call: (r) => r.countPendingWaitpoints([CUID], undefined, GEN1),
        config: { legacy: { pendingWaitpointIds: [CUID] } },
      },
      {
        name: "findManyWaitpoints by run id, an id list missing one cuid",
        call: (r) =>
          r.findManyWaitpoints({ where: { id: { in: ["wp_1", CUID] } } } as never, undefined, GEN1),
      },
      {
        name: "findRuns by an id set",
        call: (r) => r.findRuns({ where: { id: { in: [GEN1, CUID] } } }),
      },
      {
        name: "expireRunsBatch",
        call: (r) => r.expireRunsBatch([GEN1, CUID], { error: {} as never, now: new Date(0) }),
      },
      {
        name: "updateWaitpoint by a cuid found only on new",
        call: (r) => r.updateWaitpoint({ where: { id: CUID }, data: {} } as never),
        config: { legacy: { waitpoint: null } },
      },
      {
        name: "forWaitpointCompletion by a cuid found only on new",
        call: async (r) => ((await r.forWaitpointCompletion(CUID, {} as never)) as FakeStore).slot,
        config: { legacy: { waitpoint: null } },
      },
    ];

    for (const three of [false, true]) {
      for (const entry of defaults) {
        const calls: string[] = [];
        const gate = countingGate(calls, false, true, true);
        const { calls: log } = await observe(
          entry,
          { three, standIn: "m", archive: "option", gate },
          undefined,
          true
        );
        expect({ entry: entry.name, three, log, calls }).toEqual({
          entry: entry.name,
          three,
          log: [`${entry.store}:${entry.name}`],
          calls: [],
        });
      }
      for (const entry of fallBacks) {
        const calls: string[] = [];
        const gate = countingGate(calls, false, true, true);
        const withM = await observe(
          entry,
          { three, standIn: "m", archive: "option", gate },
          undefined,
          false
        );
        const without = await observe(entry, { three }, undefined, false);
        expect({ entry: entry.name, three, asked: calls, ...withM }).toEqual({
          entry: entry.name,
          three,
          asked: [],
          ...without,
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The archive behind the gate. The archive stand-in's slot is always "archive", so a router with it
// as the `archive` option compares directly with one with it as a generation 2 shard keyed "z".
// With m and the archive a router has four or more legs, so it is parallel: compare slot multisets.
// ---------------------------------------------------------------------------------------------

const isSummedWrite = (entry: Entry) =>
  /^(clearIdempotencyKey|deleteManyTaskRunWaitpoints|updateManyBatchTaskRun)/.test(entry.name);
const reads = matrix.filter((entry) => !isSummedWrite(entry));
const summedWrites = matrix.filter(isSummedWrite);

describe("the archive behind the gate", () => {
  // Catches: an open gate with both flags on leaving the archive out, or ranking it unlike a shard
  // placed directly below m.
  it("with the gate open and both flags on, asks the archive as a shard ranked below m", async () => {
    expect([reads.length, summedWrites.length]).toEqual([20, 5]);
    for (const three of [false, true]) {
      for (const failingSlot of [undefined, "archive"]) {
        for (const entry of reads) {
          const calls: string[] = [];
          const gate = countingGate(calls, false, true, true);
          const shape = { three, failingSlot, standIn: "m" as const };
          const withArchive = await observe(
            entry,
            { ...shape, archive: "option", gate },
            undefined,
            false
          );
          const asShard = await observe(
            entry,
            { ...shape, archive: "shard", gate: countingGate([], false, true) },
            undefined,
            false
          );
          const label = { entry: entry.name, three, failingSlot };
          expect({ ...label, ...withArchive }).toEqual({ ...label, ...asShard });
          expect({ ...label, asked: withArchive.calls.includes("archive"), calls }).toEqual({
            ...label,
            asked: true,
            calls: ["bornHere", "organizationOpens", "archiveFlagsOn"],
          });
        }
      }
    }
  });

  // Catches: the archive ranked above m, or its rows dropped from a merge.
  it("answers an id m holds with m's row, and an id m lacks with the archive's", async () => {
    const findRun = (r: RoutingRunStore) => r.findRun({ spanId: "s" });
    const findRuns = (r: RoutingRunStore) => r.findRuns({ where: { status: "PENDING" } });
    for (const three of [false, true]) {
      const open = () => countingGate([], false, true, true);
      let { router } = gatedRouter({ three, standIn: "m", archive: "option", gate: open() });
      expect(await findRun(router)).toEqual({ id: "run_dup", from: "m" });
      const merged = (await findRuns(router)) as Array<Record<string, unknown>>;
      expect(merged.find((row) => row.id === "run_dup")).toEqual({ id: "run_dup", from: "m" });
      expect(merged).toContainEqual({ id: "run_archive", from: "archive" });

      ({ router } = gatedRouter({
        three,
        standIn: "m",
        archive: "option",
        gate: open(),
        config: { m: { runs: [{ id: "run_m", from: "m" }] } },
      }));
      const withoutDupOnM = (await findRuns(router)) as Array<Record<string, unknown>>;
      expect(withoutDupOnM.find((row) => row.id === "run_dup")).toEqual({
        id: "run_dup",
        from: "archive",
      });
      expect(withoutDupOnM).toContainEqual({ id: "run_archive", from: "archive" });
      expect(withoutDupOnM).toContainEqual({ id: "run_m", from: "m" });
    }
  });

  // Catches: the archive asked without an open gate and both flags, or registered where no store is
  // under m.
  it("adds no leg unless the gate is open and both flags are on", async () => {
    const gen3 = generateRunOpsIdV2(MEMORYDB_SHARD_KEY);
    for (const three of [false, true]) {
      for (const entry of reads) {
        const label = { entry: entry.name, three };

        // (a) Open by the organisation, the archive's flags off.
        let calls: string[] = [];
        const flagsOff = await observe(
          entry,
          { three, standIn: "m", archive: "option", gate: countingGate(calls, false, true, false) },
          undefined,
          false
        );
        const withoutArchive = await observe(
          entry,
          { three, standIn: "m", gate: countingGate([], false, true) },
          undefined,
          false
        );
        expect({ ...label, case: "a", ...flagsOff, asked: calls }).toEqual({
          ...label,
          case: "a",
          ...withoutArchive,
          asked: ["bornHere", "organizationOpens", "archiveFlagsOn"],
        });

        // (b) Closed: no gate, and a gate answering false with the archive's flags on.
        for (const gated of [false, true]) {
          calls = [];
          const gate = gated ? countingGate(calls, false, false, true) : undefined;
          const closed = await observe(entry, { three, standIn: "m", archive: "option", gate });
          const base = await observe(entry, {
            three,
            standIn: "m",
            gate: gated ? countingGate([], false, false) : undefined,
          });
          expect({
            ...label,
            case: "b",
            gated,
            ...closed,
            asked: calls.includes("archiveFlagsOn"),
          }).toEqual({
            ...label,
            case: "b",
            gated,
            ...base,
            asked: false,
          });
        }

        // (c) Open by a generation 3 id in the predicate, with no gate injected.
        if (entry.gen3Key !== undefined) {
          const where = { [entry.gen3Key]: gen3 };
          const byId = await observe(
            entry,
            { three, standIn: "m", archive: "option" },
            where,
            false
          );
          const base = await observe(entry, { three, standIn: "m" }, where, false);
          expect({ ...label, case: "c", ...byId }).toEqual({ ...label, case: "c", ...base });
          expect(byId.calls).toContain("m");
        }

        // (d) No store under m: the archive is registered but never asked, and the gate is not asked.
        calls = [];
        const noM = await observe(entry, {
          three,
          archive: "option",
          gate: countingGate(calls, false, true, true),
        });
        const neither = await observe(entry, { three });
        expect({ ...label, case: "d", ...noM, asked: calls }).toEqual({
          ...label,
          case: "d",
          ...neither,
          asked: [],
        });

        for (const observed of [flagsOff, noM]) {
          expect({
            ...label,
            archive: observed.calls.some((c) => c.startsWith("archive")),
          }).toEqual({
            ...label,
            archive: false,
          });
        }
      }
    }
  });

  // Catches: a write summed over stores reaching the archive, or asking for its flags.
  it("never asks the archive, or its flags, for a write summed over stores", async () => {
    for (const three of [false, true]) {
      for (const entry of summedWrites) {
        const calls: string[] = [];
        const shape = { three, standIn: "m" as const };
        const withArchive = await observe(
          entry,
          { ...shape, archive: "option", gate: countingGate(calls, false, true, true) },
          undefined,
          false
        );
        const without = await observe(
          entry,
          { ...shape, gate: countingGate([], false, true) },
          undefined,
          false
        );
        const label = { entry: entry.name, three };
        expect({ ...label, ...withArchive, flagsAsked: calls.includes("archiveFlagsOn") }).toEqual({
          ...label,
          ...without,
          flagsAsked: false,
        });
        expect(withArchive.calls).not.toContain("archive");
        expect(withArchive.calls).toContain("m");
      }
    }
  });

  // Catches: the archive's flags asked before the gate opened, or more than once in one call.
  it("asks archiveFlagsOn last, and once per call", async () => {
    const gen3 = generateRunOpsIdV2(MEMORYDB_SHARD_KEY);
    const asks = async (entry: Entry, gate: MemoryDbGate, where?: Where) => {
      const { calls } = await observe(
        entry,
        { three: false, standIn: "m", archive: "option", gate },
        where,
        false
      );
      return calls.includes("archive");
    };
    for (const entry of reads) {
      let calls: string[] = [];
      let asked = await asks(entry, countingGate(calls, false, true, true));
      expect({ entry: entry.name, asked, calls }).toEqual({
        entry: entry.name,
        asked: true,
        calls: ["bornHere", "organizationOpens", "archiveFlagsOn"],
      });

      calls = [];
      asked = await asks(entry, countingGate(calls, true, false, true));
      expect({ entry: entry.name, asked, calls }).toEqual({
        entry: entry.name,
        asked: true,
        calls: ["bornHere", "archiveFlagsOn"],
      });

      if (entry.gen3Key !== undefined) {
        calls = [];
        asked = await asks(entry, countingGate(calls, false, false, true), {
          [entry.gen3Key]: gen3,
        });
        expect({ entry: entry.name, asked, calls }).toEqual({
          entry: entry.name,
          asked: true,
          calls: ["archiveFlagsOn"],
        });
      }
    }

    // The fan-out and the edge hydration share one decision.
    const withRelation: Entry = {
      name: "findManyTaskRunWaitpoints with the waitpoint relation",
      call: (r) =>
        r.findManyTaskRunWaitpoints({
          where: { waitpointId: "wp_1" },
          include: { waitpoint: true },
        } as never),
    };
    const calls: string[] = [];
    const { router, log } = gatedRouter({
      three: false,
      standIn: "m",
      archive: "option",
      gate: countingGate(calls, false, true, true),
    });
    await withRelation.call(router);
    expect({ calls, hydrated: slots(log, "findManyWaitpoints") }).toEqual({
      calls: ["bornHere", "organizationOpens", "archiveFlagsOn"],
      hydrated: ["archive", "legacy", "m", "new"],
    });
  });

  // Catches: a rejected archiveFlagsOn() swallowed, read as off, or followed by a store call.
  it("fails a read with the rejection of archiveFlagsOn, asking no store after it", async () => {
    for (const three of [false, true]) {
      for (const entry of reads) {
        const rejection = new Error("archive flags failed");
        const { router, log } = gatedRouter({
          three,
          standIn: "m",
          archive: "option",
          gate: countingGate([], false, true, rejection),
          config: entry.config,
        });
        const error = await outcome(() => entry.call(router));
        expect({ entry: entry.name, three, same: error === rejection, calls: trace(log) }).toEqual({
          entry: entry.name,
          three,
          same: true,
          calls: entry.beforeGate ?? [],
        });
      }
    }
  });

  // Catches: a gen-1 fall-back probe that walks on to the archive when neither gen-1 store has the id.
  it("ends an id-carrying fall-back on the gen-1 pair when neither holds the id", async () => {
    const nowhere = { new: { waitpoint: null }, legacy: { waitpoint: null } };
    const fallBacks: Entry[] = [
      {
        name: "updateWaitpoint by a cuid on neither gen-1 store",
        call: (r) => r.updateWaitpoint({ where: { id: CUID }, data: {} } as never),
        config: nowhere,
      },
      {
        name: "forWaitpointCompletion by a cuid on neither gen-1 store",
        call: async (r) => ((await r.forWaitpointCompletion(CUID, {} as never)) as FakeStore).slot,
        config: nowhere,
      },
    ];
    for (const three of [false, true]) {
      for (const entry of fallBacks) {
        const calls: string[] = [];
        const gate = countingGate(calls, false, true, true);
        const shape = { three, standIn: "m" as const };
        const withArchive = await observe(
          entry,
          { ...shape, archive: "option", gate },
          undefined,
          true
        );
        const without = await observe(entry, shape, undefined, true);
        expect({ entry: entry.name, three, asked: calls, ...withArchive }).toEqual({
          entry: entry.name,
          three,
          asked: [],
          ...without,
        });
      }
    }
  });

  // Catches: the archive's reserved key accepted as a shard key or as an alias target.
  it("refuses a shard keyed archive, and an alias naming the archive", () => {
    const log: Call[] = [];
    const base = { new: fakeStore("new", log), legacy: fakeStore("legacy", log) };
    const archive = fakeStore("archive", log);
    expect(
      () => new RoutingRunStore({ ...base, archive, shards: [{ key: "archive", store: archive }] })
    ).toThrow("shard keys must be unique");
    expect(
      () =>
        new RoutingRunStore({
          ...base,
          archive,
          shards: [{ key: "a", store: fakeStore("a", log), aliasOf: "archive" }],
        })
    ).toThrow('declares aliasOf "archive", which is not configured');
  });

  // Catches: the archive ranked by position (before the last key) rather than directly below m.
  it("ranks the archive directly below m when m is not the last shard", async () => {
    const log: Call[] = [];
    const make = (slot: Slot, config: FakeConfig = holding(slot)) => fakeStore(slot, log, config);
    const router = new RoutingRunStore({
      new: make("new"),
      legacy: make("legacy"),
      // "a" outranks m but does not hold run_dup, so m must outrank the archive for run_dup.
      shards: [
        { key: MEMORYDB_SHARD_KEY, store: make("m") },
        { key: "a", store: make("a", { runs: [{ id: "run_a", from: "a" }] }) },
      ],
      archive: make("archive"),
      memoryDbGate: countingGate([], false, true, true),
    });
    const rows = (await router.findRuns({ where: { status: "PENDING" } })) as Array<
      Record<string, unknown>
    >;
    expect(rows.find((row) => row.id === "run_dup")).toEqual({ id: "run_dup", from: "m" });
    expect(slots(log)).toEqual(["a", "archive", "legacy", "m", "new"]);
  });

  // Catches: the archive's read rank leaking a "shard:archive" scope that keyed waitpoint reads probe.
  it("leaves the waitpoint key scopes as they are without an archive", () => {
    for (const three of [false, true]) {
      const scopes = (archive?: "option") =>
        gatedRouter({ three, standIn: "m", archive }).router.getWaitpointKeyScopes();
      expect(scopes("option")).toEqual(scopes());
      expect(scopes("option")).not.toContain("shard:archive");
    }
  });
});
