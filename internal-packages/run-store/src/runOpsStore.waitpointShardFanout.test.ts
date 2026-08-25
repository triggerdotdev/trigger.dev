import { describe, expect, it } from "vitest";
import { generateRunOpsId, resolveShard, type ShardKey } from "@trigger.dev/core/v3/isomorphic";
import { RoutingRunStore } from "./runOpsStore.js";
import type { ReadClient, RunStore } from "./types.js";

// Regression guard for the N-way waitpoint fan-out. A waitpoint that is not on its home/run store is
// resolved by probing the OTHER shards. With two stores there is exactly one other, so taking the
// first was correct; with three+ stores (legacy + new + a gen-2 shard) taking only the first other
// silently skips the rest, missing a waitpoint that lives on a later shard. Each scenario places the
// target on the store the old first-other truncation skipped (empty shard "a" sorts first).

type Held = { waitpoints?: string[]; pending?: string[] };
type FakeStore = RunStore & { slot: ShardKey };

function idsFromArgs(args: unknown): string[] {
  const where = (args as { where?: { id?: unknown } })?.where ?? {};
  const id = where.id;
  if (typeof id === "string") return [id];
  if (id && typeof id === "object" && Array.isArray((id as { in?: unknown[] }).in)) {
    return (id as { in: unknown[] }).in.filter((x): x is string => typeof x === "string");
  }
  return [];
}

function fakeStore(slot: ShardKey, held: Held = {}): FakeStore {
  const has = new Set(held.waitpoints ?? []);
  const pending = new Set(held.pending ?? []);
  const findWaitpoint = (args: unknown) => {
    const [id] = idsFromArgs(args);
    return Promise.resolve(id && has.has(id) ? ({ id, slot } as never) : null);
  };
  const store: Partial<FakeStore> = {
    slot,
    primaryReadClient: { __primary: slot } as unknown as ReadClient,
    findWaitpoint: findWaitpoint as FakeStore["findWaitpoint"],
    findWaitpointOnPrimary: findWaitpoint as FakeStore["findWaitpointOnPrimary"],
    countPendingWaitpoints: ((ids: string[]) =>
      Promise.resolve(ids.filter((id) => pending.has(id)).length)) as FakeStore["countPendingWaitpoints"],
    countPendingWaitpointsWithPresence: ((ids: string[]) =>
      Promise.resolve({
        pendingIds: ids.filter((id) => pending.has(id)),
        presentIds: ids.filter((id) => has.has(id)),
      })) as FakeStore["countPendingWaitpointsWithPresence"],
    findManyWaitpoints: ((args: unknown) =>
      Promise.resolve(
        idsFromArgs(args)
          .filter((id) => has.has(id))
          .map((id) => ({ id, slot }))
      )) as unknown as FakeStore["findManyWaitpoints"],
  };
  return store as FakeStore;
}

// Production topology: precedence legacy -> new -> shards; probeOrder its exact reverse.
function build(stores: { legacy?: Held; new?: Held; a?: Held }) {
  const shards = new Map<ShardKey, RunStore>();
  shards.set("legacy", fakeStore("legacy", stores.legacy));
  shards.set("new", fakeStore("new", stores.new));
  shards.set("a", fakeStore("a", stores.a));
  return RoutingRunStore.fromShards({
    shards,
    probeOrder: ["a", "new", "legacy"],
    precedence: ["legacy", "new", "a"],
    idlessRouteShard: "new",
    idlessWaitpointShard: "legacy",
    resolveShardKey: resolveShard,
  });
}

// A cuid waitpoint id resolves home to "legacy"; a gen-1 run id routes the run store to "new".
const CUID_WAITPOINT = "clabc123def456ghi789jkl01";

describe("RoutingRunStore N-way waitpoint fan-out", () => {
  it("#resolveWaitpointStore finds a waitpoint that lives past the first other shard", async () => {
    const store = build({ new: { waitpoints: [CUID_WAITPOINT] } });
    const row = await store.findWaitpoint({ where: { id: CUID_WAITPOINT } });
    expect(row).toMatchObject({ id: CUID_WAITPOINT, slot: "new" });
  });

  it("countPendingWaitpoints counts a pending token on a later shard (never undercounts)", async () => {
    const runId = generateRunOpsId(); // gen-1 -> routes to "new"
    const token = "wp_pending_on_legacy";
    const store = build({ legacy: { waitpoints: [token], pending: [token] } });
    const count = await store.countPendingWaitpoints([token], undefined, runId);
    expect(count).toBe(1);
  });

  it("#collectManyWaitpoints collects a waitpoint on a later shard", async () => {
    const runId = generateRunOpsId(); // gen-1 -> routes to "new"
    const token = "wp_on_legacy";
    const store = build({ legacy: { waitpoints: [token] } });
    const rows = await store.findManyWaitpoints({ where: { id: { in: [token] } } }, undefined, runId);
    expect(rows).toEqual([{ id: token, slot: "legacy" }]);
  });
});
