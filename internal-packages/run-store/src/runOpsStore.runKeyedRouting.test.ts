import { describe, expect, it } from "vitest";
import { RoutingRunStore } from "./runOpsStore.js";
import type { ReadClient, RunStore } from "./types.js";

// Pure routing unit tests: run-keyed waitpoint/snapshot reads must route by the run id in scope
// instead of fanning out to BOTH run-ops DBs. No DB: each slot is a fake RunStore backed by a
// per-slot set of waitpoint rows / snapshot-join ids, so the assertions are purely about WHICH store
// the router queries (the co-located run's store, never the other) and about the route-then-fallback
// that keeps a rare cross-tree token visible. Correctness against real two-DB topology is covered by
// the heteroRunOpsPostgresTest suites (crossDbTokenBlock, snapshotCompletedWaitpoints, …).
//
// Every case runs at TWO shards (the compat pair) and at THREE (the pair plus one gen-2 shard).
// #collectManyWaitpoints and countPendingWaitpoints partition the ids MISSING from the run's store:
// a gen-2 id goes to its own shard, a cuid to both gen-1 stores. At two shards those two rules pick
// the same single store, so the partition is unobservable. The third shard separates them.
//
// The seam is `resolveShard`, not `classify`: a gen-1 classifier maps through a binary ternary and
// can never name a gen-2 shard.

type Call = { method: string; args: unknown[] };

type WaitpointRow = { id: string; status: "PENDING" | "COMPLETED" };

type FakeConfig = {
  // Waitpoint rows resident on this store, keyed by id → status (for findManyWaitpoints /
  // countPendingWaitpoints[WithPresence]).
  waitpoints?: WaitpointRow[];
  // Snapshot-join waitpoint ids resident on this store (for findSnapshotCompletedWaitpointIds).
  snapshotWaitpointIds?: string[];
  // Whether this store has the snapshot at all (for the WithPresence variant).
  snapshotPresent?: boolean;
  // Edge rows to return from findManyTaskRunWaitpoints, regardless of filter (routing-only).
  edges?: Array<Record<string, unknown>>;
};

type Slot = "new" | "legacy" | "a";

type FakeStore = RunStore & {
  slot: Slot;
  calls: Call[];
  primaryReadClient: { __primary: Slot };
};

function idsFromWhere(where: unknown): string[] | undefined {
  const id = (where as { id?: unknown } | undefined)?.id;
  if (typeof id === "string") return [id];
  if (id && typeof id === "object") {
    const inArr = (id as { in?: unknown }).in;
    if (Array.isArray(inArr)) return inArr.filter((x): x is string => typeof x === "string");
  }
  return undefined;
}

function fakeStore(slot: Slot, config: FakeConfig = {}): FakeStore {
  const calls: Call[] = [];
  const rows = config.waitpoints ?? [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const record = (method: string) => (args: unknown[]) => calls.push({ method, args });

  const store: Partial<FakeStore> = {
    slot,
    calls,
    primaryReadClient: { __primary: slot },

    findManyTaskRunWaitpoints: ((args: unknown, client?: ReadClient) => {
      record("findManyTaskRunWaitpoints")([args, client]);
      return Promise.resolve((config.edges ?? []) as never);
    }) as FakeStore["findManyTaskRunWaitpoints"],

    deleteManyTaskRunWaitpoints: ((args: unknown, tx?: unknown) => {
      record("deleteManyTaskRunWaitpoints")([args, tx]);
      return Promise.resolve({ count: rows.length } as never);
    }) as FakeStore["deleteManyTaskRunWaitpoints"],

    findSnapshotCompletedWaitpointIds: ((snapshotId: string, client?: ReadClient) => {
      record("findSnapshotCompletedWaitpointIds")([snapshotId, client]);
      return Promise.resolve(config.snapshotWaitpointIds ?? []);
    }) as FakeStore["findSnapshotCompletedWaitpointIds"],

    findSnapshotCompletedWaitpointIdsWithPresence: ((snapshotId: string, client?: ReadClient) => {
      record("findSnapshotCompletedWaitpointIdsWithPresence")([snapshotId, client]);
      return Promise.resolve({
        present: config.snapshotPresent ?? false,
        ids: config.snapshotWaitpointIds ?? [],
      });
    }) as FakeStore["findSnapshotCompletedWaitpointIdsWithPresence"],

    findManyWaitpoints: ((args: { where?: unknown }, client?: ReadClient) => {
      record("findManyWaitpoints")([args, client]);
      const requested = idsFromWhere(args.where);
      const result =
        requested === undefined
          ? rows
          : requested.map((id) => byId.get(id)).filter((r): r is WaitpointRow => r != null);
      return Promise.resolve(result as never);
    }) as FakeStore["findManyWaitpoints"],

    countPendingWaitpoints: ((waitpointIds: string[], client?: ReadClient) => {
      record("countPendingWaitpoints")([waitpointIds, client]);
      const count = waitpointIds.filter((id) => byId.get(id)?.status === "PENDING").length;
      return Promise.resolve(count);
    }) as FakeStore["countPendingWaitpoints"],

    countPendingWaitpointsWithPresence: ((waitpointIds: string[], client?: ReadClient) => {
      record("countPendingWaitpointsWithPresence")([waitpointIds, client]);
      const presentIds = waitpointIds.filter((id) => byId.has(id));
      const pendingIds = presentIds.filter((id) => byId.get(id)?.status === "PENDING");
      return Promise.resolve({ pendingIds, presentIds });
    }) as FakeStore["countPendingWaitpointsWithPresence"],
  };

  return store as unknown as FakeStore;
}

type Topology = { name: string; gen2Keys: readonly Slot[] };

const TOPOLOGIES: readonly Topology[] = [
  { name: "compat pair", gen2Keys: [] },
  { name: "one gen-2 shard", gen2Keys: ["a"] },
];

// Deterministic residency by id prefix via the resolveShard seam (no dependence on id-shape rules).
function buildRouterFor(
  topology: Topology,
  newConfig: FakeConfig = {},
  legacyConfig: FakeConfig = {},
  shardConfig: FakeConfig = {}
) {
  const newStore = fakeStore("new", newConfig);
  const legacyStore = fakeStore("legacy", legacyConfig);
  const gen2Stores = topology.gen2Keys.map((key) => fakeStore(key, shardConfig));
  const router = new RoutingRunStore({
    new: newStore,
    legacy: legacyStore,
    resolveShard: (id: string) =>
      id.startsWith("new") ? "new" : id.startsWith("a_") ? "a" : "legacy",
    ...(gen2Stores.length > 0
      ? { shards: gen2Stores.map((store) => ({ key: store.slot, store })) }
      : {}),
  });
  return { router, newStore, legacyStore, gen2Stores };
}

const WRITER = { __writer: true } as unknown as ReadClient; // non-replica → escalates to own primary

for (const topology of TOPOLOGIES) {
  describe(`RoutingRunStore.findManyTaskRunWaitpoints — route by taskRunId (no fan-out) (${topology.name})`, () => {
    it("routes an edge read keyed by a NEW run id to the new store only", async () => {
      const { router, newStore, legacyStore } = buildRouterFor(topology);
      await router.findManyTaskRunWaitpoints({
        where: { taskRunId: "new_run" },
        select: { taskRunId: true },
      });
      expect(newStore.calls.map((c) => c.method)).toEqual(["findManyTaskRunWaitpoints"]);
      expect(legacyStore.calls).toHaveLength(0);
    });

    it("routes an edge read keyed by a LEGACY run id to the legacy store only", async () => {
      const { router, newStore, legacyStore } = buildRouterFor(topology);
      await router.findManyTaskRunWaitpoints({
        where: { taskRunId: "legacy_run" },
        select: { taskRunId: true },
      });
      expect(legacyStore.calls.map((c) => c.method)).toEqual(["findManyTaskRunWaitpoints"]);
      expect(newStore.calls).toHaveLength(0);
    });

    it("escalates a caller writer client to the owning store's own primary", async () => {
      const { router, newStore } = buildRouterFor(topology);
      await router.findManyTaskRunWaitpoints(
        { where: { taskRunId: "new_run" }, select: { taskRunId: true } },
        WRITER
      );
      expect(newStore.calls[0]?.args[1]).toEqual({ __primary: "new" });
    });

    it("still fans out when keyed by waitpointId (no run id in scope)", async () => {
      const { router, newStore, legacyStore } = buildRouterFor(topology);
      await router.findManyTaskRunWaitpoints({
        where: { waitpointId: "waitpoint_x" },
        select: { taskRunId: true },
      });
      expect(newStore.calls).toHaveLength(1);
      expect(legacyStore.calls).toHaveLength(1);
    });
  });

  describe(`RoutingRunStore.deleteManyTaskRunWaitpoints — route by taskRunId (no fan-out) (${topology.name})`, () => {
    it("deletes only on the owning store for a classifiable taskRunId", async () => {
      const { router, newStore, legacyStore } = buildRouterFor(topology, { waitpoints: [] });
      const result = await router.deleteManyTaskRunWaitpoints({
        where: { taskRunId: "legacy_run", id: { in: ["waitpoint_a"] } },
      });
      expect(legacyStore.calls.map((c) => c.method)).toEqual(["deleteManyTaskRunWaitpoints"]);
      expect(newStore.calls).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it("still fans out and sums when there is no taskRunId in the where", async () => {
      const { router, newStore, legacyStore } = buildRouterFor(topology);
      await router.deleteManyTaskRunWaitpoints({ where: { waitpointId: "waitpoint_x" } });
      expect(newStore.calls).toHaveLength(1);
      expect(legacyStore.calls).toHaveLength(1);
    });

    it("never threads a caller tx into the routed delete", async () => {
      const { router, legacyStore } = buildRouterFor(topology);
      await router.deleteManyTaskRunWaitpoints({ where: { taskRunId: "legacy_run" } }, {
        $fake: "cp-tx",
      } as never);
      expect(legacyStore.calls[0]?.args[1]).toBeUndefined();
    });
  });

  describe(`RoutingRunStore.findSnapshotCompletedWaitpointIds — route by runId (${topology.name})`, () => {
    it("routes to the run's store when a runId is threaded through", async () => {
      const { router, newStore, legacyStore } = buildRouterFor(
        topology,
        { snapshotWaitpointIds: ["waitpoint_n"] },
        { snapshotWaitpointIds: ["waitpoint_l"] }
      );
      const ids = await router.findSnapshotCompletedWaitpointIds(
        "c".repeat(25),
        undefined,
        "new_run"
      );
      expect(ids).toEqual(["waitpoint_n"]);
      expect(legacyStore.calls).toHaveLength(0);
      expect(newStore.calls.map((c) => c.method)).toEqual(["findSnapshotCompletedWaitpointIds"]);
    });

    it("still fans out and merges when no runId is supplied", async () => {
      const { router, newStore, legacyStore } = buildRouterFor(
        topology,
        { snapshotWaitpointIds: ["waitpoint_n"] },
        { snapshotWaitpointIds: ["waitpoint_l"] }
      );
      const ids = await router.findSnapshotCompletedWaitpointIds("c".repeat(25));
      expect(ids.sort()).toEqual(["waitpoint_l", "waitpoint_n"]);
      expect(newStore.calls).toHaveLength(1);
      expect(legacyStore.calls).toHaveLength(1);
    });
  });

  describe(`RoutingRunStore.findSnapshotCompletedWaitpointIdsWithPresence — route by runId (${topology.name})`, () => {
    it("routes to the run's store when a runId is threaded through", async () => {
      const { router, newStore } = buildRouterFor(
        topology,
        { snapshotWaitpointIds: ["waitpoint_n"], snapshotPresent: true },
        { snapshotWaitpointIds: ["waitpoint_l"], snapshotPresent: true }
      );
      const res = await router.findSnapshotCompletedWaitpointIdsWithPresence(
        "c".repeat(25),
        undefined,
        "legacy_run"
      );
      expect(res).toEqual({ present: true, ids: ["waitpoint_l"] });
      expect(newStore.calls).toHaveLength(0);
    });

    it("still fans out (present is the OR) when no runId is supplied", async () => {
      const { router } = buildRouterFor(
        topology,
        { snapshotWaitpointIds: [], snapshotPresent: false },
        { snapshotWaitpointIds: ["waitpoint_l"], snapshotPresent: true }
      );
      const res = await router.findSnapshotCompletedWaitpointIdsWithPresence("c".repeat(25));
      expect(res).toEqual({ present: true, ids: ["waitpoint_l"] });
    });
  });

  describe(`RoutingRunStore.findManyWaitpoints — route by runId then fall back for missing ids (${topology.name})`, () => {
    it("queries only the run's store when every requested token co-locates with the run", async () => {
      const { router, newStore, legacyStore } = buildRouterFor(topology, {
        waitpoints: [
          { id: "waitpoint_a", status: "COMPLETED" },
          { id: "waitpoint_b", status: "COMPLETED" },
        ],
      });
      const rows = (await router.findManyWaitpoints(
        { where: { id: { in: ["waitpoint_a", "waitpoint_b"] } } },
        undefined,
        "new_run"
      )) as WaitpointRow[];
      expect(rows.map((r) => r.id).sort()).toEqual(["waitpoint_a", "waitpoint_b"]);
      expect(legacyStore.calls).toHaveLength(0);
      expect(newStore.calls).toHaveLength(1);
    });

    it("falls back to the other store for ONLY the ids missing on the run's store (cross-tree token)", async () => {
      const { router, legacyStore, gen2Stores } = buildRouterFor(
        topology,
        { waitpoints: [{ id: "waitpoint_local", status: "COMPLETED" }] },
        { waitpoints: [{ id: "waitpoint_crosstree", status: "COMPLETED" }] }
      );
      const rows = (await router.findManyWaitpoints(
        { where: { id: { in: ["waitpoint_local", "waitpoint_crosstree"] } } },
        undefined,
        "new_run"
      )) as WaitpointRow[];
      expect(rows.map((r) => r.id).sort()).toEqual(["waitpoint_crosstree", "waitpoint_local"]);
      // The fallback leg is queried with ONLY the missing id, never the whole set.
      const fallbackCall = legacyStore.calls[0];
      expect(fallbackCall?.method).toBe("findManyWaitpoints");
      const fallbackWhere = (fallbackCall!.args[0] as { where?: unknown }).where;
      expect(idsFromWhere(fallbackWhere)).toEqual(["waitpoint_crosstree"]);
      // A cuid absent id probes the gen-1 pair ONLY. It must never reach a gen-2 shard.
      for (const store of gen2Stores) {
        expect(store.calls).toHaveLength(0);
      }
    });

    it("still fans out (NEW-wins dedup) when no runId is supplied", async () => {
      const { router, newStore, legacyStore } = buildRouterFor(
        topology,
        { waitpoints: [{ id: "waitpoint_a", status: "COMPLETED" }] },
        { waitpoints: [{ id: "waitpoint_a", status: "PENDING" }] }
      );
      const rows = (await router.findManyWaitpoints({
        where: { id: { in: ["waitpoint_a"] } },
      })) as WaitpointRow[];
      expect(newStore.calls).toHaveLength(1);
      expect(legacyStore.calls).toHaveLength(1);
      // NEW-wins: the deduped row is the NEW copy (COMPLETED), not the stale legacy PENDING one.
      expect(rows).toEqual([{ id: "waitpoint_a", status: "COMPLETED" }]);
    });
  });

  describe(`RoutingRunStore.countPendingWaitpoints — route by runId then partition-fallback (${topology.name})`, () => {
    it("counts on the run's store only when every waitpoint co-locates with the run", async () => {
      const { router, newStore, legacyStore } = buildRouterFor(topology, {
        waitpoints: [
          { id: "waitpoint_a", status: "PENDING" },
          { id: "waitpoint_b", status: "COMPLETED" },
        ],
      });
      const count = await router.countPendingWaitpoints(
        ["waitpoint_a", "waitpoint_b"],
        undefined,
        "new_run"
      );
      expect(count).toBe(1);
      expect(legacyStore.calls).toHaveLength(0);
      expect(newStore.calls.map((c) => c.method)).toEqual(["countPendingWaitpointsWithPresence"]);
    });

    it("counts a cross-tree pending token via the fallback so a blocked run is not prematurely unblocked", async () => {
      // The classic crossDbTokenBlock shape: a LEGACY run blocks on a token resident on the NEW DB.
      const { router, newStore } = buildRouterFor(
        topology,
        { waitpoints: [{ id: "waitpoint_crosstree", status: "PENDING" }] },
        { waitpoints: [] }
      );
      const count = await router.countPendingWaitpoints(
        ["waitpoint_crosstree"],
        undefined,
        "legacy_run"
      );
      expect(count).toBe(1);
      // Fallback queried the other store with ONLY the id missing on the run's store. It uses the
      // presence variant so the results can be unioned by id (a drain mirror counts once at N).
      expect(newStore.calls.map((c) => c.method)).toEqual(["countPendingWaitpointsWithPresence"]);
      expect(newStore.calls[0]?.args[0]).toEqual(["waitpoint_crosstree"]);
    });

    it("trusts the run's store for an id present there (COMPLETED) even if a stale mirror is PENDING elsewhere", async () => {
      const { router, legacyStore } = buildRouterFor(
        topology,
        { waitpoints: [{ id: "waitpoint_a", status: "COMPLETED" }] },
        { waitpoints: [{ id: "waitpoint_a", status: "PENDING" }] }
      );
      const count = await router.countPendingWaitpoints(["waitpoint_a"], undefined, "new_run");
      // Present on the run's store → not in the missing set → the other store is never consulted.
      expect(count).toBe(0);
      expect(legacyStore.calls).toHaveLength(0);
    });

    it("still fans out and sums when no runId is supplied", async () => {
      const { router, newStore, legacyStore } = buildRouterFor(
        topology,
        { waitpoints: [{ id: "waitpoint_a", status: "PENDING" }] },
        { waitpoints: [{ id: "waitpoint_b", status: "PENDING" }] }
      );
      const count = await router.countPendingWaitpoints(["waitpoint_a", "waitpoint_b"]);
      expect(count).toBe(2);
      expect(newStore.calls).toHaveLength(1);
      expect(legacyStore.calls).toHaveLength(1);
    });
  });
}

// A gen-2 shard exists only in the three-shard topology, so this case has no two-shard counterpart.
describe("RoutingRunStore — a gen-2 absent id partitions to its own shard", () => {
  it("sends a missing gen-2 waitpoint id to its shard and never to the gen-1 partner", async () => {
    const { router, newStore, legacyStore, gen2Stores } = buildRouterFor(
      TOPOLOGIES[1]!,
      { waitpoints: [{ id: "waitpoint_local", status: "COMPLETED" }] },
      { waitpoints: [] },
      { waitpoints: [{ id: "a_waitpoint", status: "COMPLETED" }] }
    );
    const rows = (await router.findManyWaitpoints(
      { where: { id: { in: ["waitpoint_local", "a_waitpoint"] } } },
      undefined,
      "new_run"
    )) as WaitpointRow[];
    expect(rows.map((r) => r.id).sort()).toEqual(["a_waitpoint", "waitpoint_local"]);
    expect(newStore.calls).toHaveLength(1);
    // The id names its shard, so the partition must not widen to the gen-1 partner.
    expect(legacyStore.calls).toHaveLength(0);
    expect(gen2Stores[0]!.calls).toHaveLength(1);
    const where = (gen2Stores[0]!.calls[0]!.args[0] as { where?: unknown }).where;
    expect(idsFromWhere(where)).toEqual(["a_waitpoint"]);
  });

  it("counts a pending gen-2 token through the partition fallback", async () => {
    const { router, legacyStore, gen2Stores } = buildRouterFor(
      TOPOLOGIES[1]!,
      { waitpoints: [] },
      { waitpoints: [] },
      { waitpoints: [{ id: "a_waitpoint", status: "PENDING" }] }
    );
    const count = await router.countPendingWaitpoints(["a_waitpoint"], undefined, "new_run");
    expect(count).toBe(1);
    expect(legacyStore.calls).toHaveLength(0);
    expect(gen2Stores[0]!.calls.map((c) => c.method)).toEqual([
      "countPendingWaitpointsWithPresence",
    ]);
  });
});
