import { describe, expect, it } from "vitest";
import { RoutingRunStore } from "./runOpsStore.js";
import type { RoutingStoreMetrics } from "./routingStoreMetrics.js";
import type { FinalizeRunData, RunStore } from "./types.js";

// Pure routing unit tests for the five store methods added in Track 1. No DB: each slot is a fake
// RunStore that records the calls it receives, so the assertions are purely about WHICH store the
// router dispatches to (by residency key) and WHAT it forwards (never a control-plane tx into a
// routed write; caller client presence escalates to the owning store's own primary).
//
// Every case runs at TWO shards (the compat pair) and at THREE (the pair plus one gen-2 shard).
// The routed cases prove a write never drifts onto a shard that cannot own it. The merge case is
// topology-indexed: #precedence is [legacy, new, ...gen2] with last-write-wins, so the winner of a
// duplicate id CHANGES when a gen-2 leg holds it, and #reportDuplicateId alarms because the
// reporting set is no longer a subset of the gen-1 pair.
//
// The seam is `resolveShard`, not `classify`: a gen-1 classifier maps through a binary ternary and
// can only ever name the two reserved keys, so it can never reach a gen-2 shard.

type Call = { method: string; args: unknown[] };

// Shard key "z", because the merged tag rows already use the ids "a", "b" and "c".
type Slot = "new" | "legacy" | "z";

type FakeStore = RunStore & {
  slot: Slot;
  calls: Call[];
  primaryReadClient: { __primary: Slot };
};

// The gen-2 leg collides on "a" ONLY, so the merged id set is unchanged and the single observable
// difference between the two topologies is which leg wins that duplicate.
function tagRows(slot: Slot) {
  if (slot === "new") {
    return [
      { id: "b", src: "new" },
      { id: "a", src: "new" },
    ];
  }
  if (slot === "legacy") {
    return [
      { id: "c", src: "legacy" },
      { id: "a", src: "legacy" },
    ];
  }
  return [{ id: "a", src: slot }];
}

function fakeStore(slot: Slot): FakeStore {
  const calls: Call[] = [];
  const record =
    (method: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  return {
    slot,
    calls,
    primaryReadClient: { __primary: slot },
    finalizeRun: record("finalizeRun", { slot, kind: "run" }),
    findManyBatchTaskRunItems: record("findManyBatchTaskRunItems", [{ slot }]),
    findBatchTaskRunItem: record("findBatchTaskRunItem", { slot }),
    upsertWaitpointTag: record("upsertWaitpointTag", { slot }),
    findManyWaitpointTags: record("findManyWaitpointTags", tagRows(slot)),
  } as unknown as FakeStore;
}

type Topology = { name: string; gen2Keys: readonly Slot[] };

const TOPOLOGIES: readonly Topology[] = [
  { name: "compat pair", gen2Keys: [] },
  { name: "one gen-2 shard", gen2Keys: ["z"] },
];

// Deterministic residency by id prefix, injected via the resolveShard seam so the tests don't
// depend on id-shape length rules.
function buildRouter(topology: Topology, metrics?: RoutingStoreMetrics) {
  const newStore = fakeStore("new");
  const legacyStore = fakeStore("legacy");
  const gen2Stores = topology.gen2Keys.map((key) => fakeStore(key));
  const router = new RoutingRunStore({
    new: newStore,
    legacy: legacyStore,
    resolveShard: (id: string) =>
      id.startsWith("new") ? "new" : id.startsWith("z_") ? "z" : "legacy",
    ...(gen2Stores.length > 0
      ? { shards: gen2Stores.map((store) => ({ key: store.slot, store })) }
      : {}),
    ...(metrics ? { metrics } : {}),
  });
  return { router, newStore, legacyStore, gen2Stores };
}

const DATA: FinalizeRunData = { status: "COMPLETED_SUCCESSFULLY", completedAt: new Date() };

for (const topology of TOPOLOGIES) {
  describe(`RoutingRunStore.finalizeRun (${topology.name})`, () => {
    it("routes by runId and forwards the projection, never the tx", async () => {
      const { router, newStore, legacyStore } = buildRouter(topology);
      const projection = { select: { id: true } };
      await router.finalizeRun("new_run", DATA, projection);
      expect(newStore.calls).toHaveLength(1);
      expect(newStore.calls[0]?.args).toEqual(["new_run", DATA, projection]);
      expect(legacyStore.calls).toHaveLength(0);
    });

    it("routes a cuid/legacy runId to the legacy store", async () => {
      const { router, newStore, legacyStore } = buildRouter(topology);
      await router.finalizeRun("legacy_run", DATA, { include: { attempts: true } });
      expect(legacyStore.calls[0]?.args).toEqual([
        "legacy_run",
        DATA,
        { include: { attempts: true } },
      ]);
      expect(newStore.calls).toHaveLength(0);
    });

    it("drops a caller-passed control-plane tx (never threaded into the routed write)", async () => {
      const { router, legacyStore } = buildRouter(topology);
      const controlPlaneTx = { $fake: "cp-tx" };
      await router.finalizeRun("legacy_run", DATA, controlPlaneTx as never);
      // The tx is neither a select/include projection nor forwarded: the sub-store sees a 3-arg call
      // whose projection slot is undefined.
      expect(legacyStore.calls[0]?.args).toEqual(["legacy_run", DATA, undefined]);
    });
  });

  describe(`RoutingRunStore.findManyBatchTaskRunItems (${topology.name})`, () => {
    it("routes by batchTaskRunId first", async () => {
      const { router, newStore, legacyStore } = buildRouter(topology);
      await router.findManyBatchTaskRunItems({
        batchTaskRunId: "new_batch",
        taskRunId: "legacy_run",
      });
      expect(newStore.calls[0]?.method).toBe("findManyBatchTaskRunItems");
      expect(legacyStore.calls).toHaveLength(0);
    });

    it("falls back to taskRunId when no batchTaskRunId is present", async () => {
      const { router, newStore, legacyStore } = buildRouter(topology);
      await router.findManyBatchTaskRunItems({ taskRunId: "legacy_run" });
      expect(legacyStore.calls[0]?.method).toBe("findManyBatchTaskRunItems");
      expect(newStore.calls).toHaveLength(0);
    });

    it("escalates a caller client to the owning store's own primary (read-your-writes)", async () => {
      const { router, newStore } = buildRouter(topology);
      // A non-replica client object signals read-your-writes; it must NOT be forwarded verbatim.
      await router.findManyBatchTaskRunItems({ batchTaskRunId: "new_batch" }, undefined, {
        writer: true,
      } as never);
      expect(newStore.calls[0]?.args[2]).toEqual({ __primary: "new" });
    });
  });

  describe(`RoutingRunStore.findBatchTaskRunItem (${topology.name})`, () => {
    it("routes by batchTaskRunId", async () => {
      const { router, newStore, legacyStore } = buildRouter(topology);
      await router.findBatchTaskRunItem({ batchTaskRunId: "legacy_batch", taskRunId: "new_run" });
      expect(legacyStore.calls[0]?.method).toBe("findBatchTaskRunItem");
      expect(newStore.calls).toHaveLength(0);
    });
  });

  describe(`RoutingRunStore.upsertWaitpointTag (${topology.name})`, () => {
    it("routes the write by the tag's minted id-shape (env mint-kind)", async () => {
      const { router, newStore, legacyStore } = buildRouter(topology);
      await router.upsertWaitpointTag({
        environmentId: "env",
        name: "t",
        projectId: "p",
        id: "new_tag",
      });
      expect(newStore.calls[0]?.method).toBe("upsertWaitpointTag");
      expect(legacyStore.calls).toHaveLength(0);
    });

    it("falls back to legacy when no minted id is supplied", async () => {
      const { router, newStore, legacyStore } = buildRouter(topology);
      await router.upsertWaitpointTag({ environmentId: "env", name: "t", projectId: "p" });
      expect(legacyStore.calls[0]?.method).toBe("upsertWaitpointTag");
      expect(newStore.calls).toHaveLength(0);
    });

    it("never threads a control-plane tx into either leg", async () => {
      const { router, newStore, legacyStore } = buildRouter(topology);
      const tx = { $fake: "cp-tx" };
      await router.upsertWaitpointTag(
        { environmentId: "env", name: "t", projectId: "p", id: "legacy_tag" },
        tx as never
      );
      // The routed write runs on the owning store's own client, so the tx is dropped on the LEGACY leg too.
      expect(legacyStore.calls[0]?.args[1]).toBeUndefined();

      const tx2 = { $fake: "cp-tx-2" };
      await router.upsertWaitpointTag(
        { environmentId: "env", name: "t", projectId: "p", id: "new_tag" },
        tx2 as never
      );
      // NEW leg likewise never receives the control-plane tx.
      expect(newStore.calls[0]?.args[1]).toBeUndefined();
    });
  });

  describe(`RoutingRunStore.findManyWaitpointTags (${topology.name})`, () => {
    it("fans out to both stores, de-dupes NEW-wins, and re-imposes orderBy/take/skip globally", async () => {
      const { router, newStore, legacyStore, gen2Stores } = buildRouter(topology);
      const result = (await router.findManyWaitpointTags({
        where: { environmentId: "env" },
        orderBy: { id: "desc" },
        take: 2,
        skip: 1,
      })) as Array<{ id: string; src: string }>;

      // Union {a,b,c} sorted desc = [c,b,a]; slice(1,3) = [b,a]. The id set does not move with the
      // topology; only the winner of the "a" collision does, because #precedence puts gen-2 last.
      expect(result.map((r) => r.id)).toEqual(["b", "a"]);
      expect(result.find((r) => r.id === "a")?.src).toBe(gen2Stores.at(-1)?.slot ?? "new");

      // Each leg is widened: skip dropped to 0, take widened to skip+take.
      expect((newStore.calls[0]!.args[0] as { take: number; skip: number }).take).toBe(3);
      expect((newStore.calls[0]!.args[0] as { take: number; skip: number }).skip).toBe(0);
      expect((legacyStore.calls[0]!.args[0] as { take: number; skip: number }).take).toBe(3);
    });

    it("alarms for a tag id held by a gen-2 shard, and stays silent across the gen-1 pair", async () => {
      const seen: string[][] = [];
      const { router } = buildRouter(topology, {
        recordDuplicateId: (keys) => seen.push(keys),
        recordWaitpointProbeFallback() {},
      });
      await router.findManyWaitpointTags({ where: { environmentId: "env" } });
      // A duplicate confined to {legacy, new} is the known drain-mirror case and stays silent. Once a
      // gen-2 leg reports the same id the set is no longer a subset of the pair, so it must alarm.
      expect(seen).toEqual(topology.gen2Keys.length > 0 ? [["legacy", "new", "z"]] : []);
    });
  });
}
