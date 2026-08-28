import { describe, expect, it } from "vitest";
import { RoutingRunStore } from "./runOpsStore.js";
import type { RunStore } from "./types.js";

// Env-scoped writes with no owning run (waitpoint tags; idempotency-key reset by predicate) must
// route to NEW when the env mints run-ops ids, instead of defaulting to LEGACY / fanning a wrong-DB
// write. Pure routing: fake RunStore slots record which store the router dispatches to.
//
// Every case runs at TWO shards (the compat pair) and at THREE (the pair plus one gen-2 shard).
// clearIdempotencyKey is the ONLY caller of #shardsExcept, which must fan out over every remaining
// store rather than take the first. At two shards that list holds one entry, so the fan-out is
// degenerate and a take-the-first bug is invisible. The third shard makes it observable.
//
// The seam stays `classify` (binary NEW/LEGACY) on purpose: these paths are selected by the
// residency hint and by fan-out membership, never by id shape. The gen-2 id algebra lives in
// runOpsStore.shardMap.test.ts.

type Call = { method: string; args: unknown[] };
type Slot = "new" | "legacy" | "a";
type FakeStore = RunStore & { slot: Slot; calls: Call[] };

// `clearCount` lets a test say "this store matched N rows for the reset", so the NEW-first-then-fallback
// path can be exercised (NEW matches 0 → fall back to the other stores).
function fakeStore(slot: Slot, clearCount = slot === "new" ? 1 : 0): FakeStore {
  const calls: Call[] = [];
  const rec =
    (method: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  return {
    slot,
    calls,
    upsertWaitpointTag: rec("upsertWaitpointTag", { id: slot, slot }),
    clearIdempotencyKey: rec("clearIdempotencyKey", { count: clearCount }),
  } as unknown as FakeStore;
}

type Topology = { name: string; gen2Keys: readonly Slot[] };

const TOPOLOGIES: readonly Topology[] = [
  { name: "compat pair", gen2Keys: [] },
  { name: "one gen-2 shard", gen2Keys: ["a"] },
];

type Counts = { new?: number; legacy?: number; a?: number };

function buildRouter(topology: Topology, counts: Counts = {}) {
  const newStore = fakeStore("new", counts.new);
  const legacyStore = fakeStore("legacy", counts.legacy);
  const gen2Stores = topology.gen2Keys.map((key) => fakeStore(key, counts[key]));
  const router = new RoutingRunStore({
    new: newStore,
    legacy: legacyStore,
    classify: (id: string) => (id.startsWith("new") ? "NEW" : "LEGACY"),
    ...(gen2Stores.length > 0
      ? { shards: gen2Stores.map((store) => ({ key: store.slot, store })) }
      : {}),
  });
  return { router, newStore, legacyStore, gen2Stores };
}

for (const topology of TOPOLOGIES) {
  describe(`RoutingRunStore.upsertWaitpointTag — residency hint for a tag with no minted id (${topology.name})`, () => {
    it("routes to NEW when residency is NEW and no id is supplied", async () => {
      const { router, newStore, legacyStore, gen2Stores } = buildRouter(topology);
      await router.upsertWaitpointTag(
        { environmentId: "env", name: "t", projectId: "p" },
        undefined,
        "NEW"
      );
      expect(newStore.calls.map((c) => c.method)).toEqual(["upsertWaitpointTag"]);
      expect(legacyStore.calls).toHaveLength(0);
      for (const store of gen2Stores) {
        expect(store.calls).toHaveLength(0);
      }
    });

    it("still falls back to LEGACY when no id and no residency are supplied", async () => {
      const { router, newStore, legacyStore, gen2Stores } = buildRouter(topology);
      await router.upsertWaitpointTag({ environmentId: "env", name: "t", projectId: "p" });
      expect(legacyStore.calls.map((c) => c.method)).toEqual(["upsertWaitpointTag"]);
      expect(newStore.calls).toHaveLength(0);
      // #idlessWaitpointShard stays legacy at any shard count.
      for (const store of gen2Stores) {
        expect(store.calls).toHaveLength(0);
      }
    });
  });

  describe(`RoutingRunStore.clearIdempotencyKey — predicate routes NEW-first when the env mints new (${topology.name})`, () => {
    it("clears on NEW and does NOT touch the other stores when NEW matches (post-flip key)", async () => {
      const { router, newStore, legacyStore, gen2Stores } = buildRouter(topology, {
        new: 1,
        legacy: 0,
        a: 0,
      });
      const result = await router.clearIdempotencyKey({
        byPredicate: {
          idempotencyKey: "k",
          taskIdentifier: "task",
          runtimeEnvironmentId: "env",
          residency: "NEW",
        },
      });
      expect(newStore.calls.map((c) => c.method)).toEqual(["clearIdempotencyKey"]);
      expect(legacyStore.calls).toHaveLength(0);
      // The NEW short circuit must not widen with the shard count.
      for (const store of gen2Stores) {
        expect(store.calls).toHaveLength(0);
      }
      expect(result.count).toBe(1);
    });

    it("falls back to EVERY other store when NEW matches 0 (a key held on a pre-flip run)", async () => {
      // The env mints new now, but this key was created before the flip → its run lives elsewhere.
      // #shardsExcept(NEW) must yield every remaining store, not just the first one.
      const { router, newStore, legacyStore, gen2Stores } = buildRouter(topology, {
        new: 0,
        legacy: 1,
        a: 1,
      });
      const result = await router.clearIdempotencyKey({
        byPredicate: {
          idempotencyKey: "k",
          taskIdentifier: "task",
          runtimeEnvironmentId: "env",
          residency: "NEW",
        },
      });
      expect(newStore.calls).toHaveLength(1);
      expect(legacyStore.calls).toHaveLength(1);
      for (const store of gen2Stores) {
        expect(store.calls).toHaveLength(1);
      }
      // A take-the-first fan-out returns 1 here, leaving the stale key on shard "a" deduping.
      expect(result.count).toBe(1 + gen2Stores.length);
    });

    it("still fans out a byPredicate reset with no residency (mixed residency)", async () => {
      const { router, newStore, legacyStore, gen2Stores } = buildRouter(topology);
      await router.clearIdempotencyKey({
        byPredicate: { idempotencyKey: "k", taskIdentifier: "task", runtimeEnvironmentId: "env" },
      });
      // #sumCounts spans every distinct store, so the fan widens with the shard count.
      expect(newStore.calls).toHaveLength(1);
      expect(legacyStore.calls).toHaveLength(1);
      for (const store of gen2Stores) {
        expect(store.calls).toHaveLength(1);
      }
    });

    it("routes byId to the owning store (unchanged)", async () => {
      const { router, newStore, legacyStore, gen2Stores } = buildRouter(topology);
      await router.clearIdempotencyKey({ byId: { runId: "new_run", idempotencyKey: "k" } });
      expect(newStore.calls.map((c) => c.method)).toEqual(["clearIdempotencyKey"]);
      expect(legacyStore.calls).toHaveLength(0);
      for (const store of gen2Stores) {
        expect(store.calls).toHaveLength(0);
      }
    });
  });
}
