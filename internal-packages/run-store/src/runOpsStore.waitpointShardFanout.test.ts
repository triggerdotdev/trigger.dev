import { describe, expect, it } from "vitest";
import {
  generateRunOpsId,
  generateRunOpsIdV2,
  resolveShard,
  type ShardKey,
} from "@trigger.dev/core/v3/isomorphic";
import { RoutingRunStore } from "./runOpsStore.js";
import type { ReadClient, RunStore } from "./types.js";

// Regression guard for the N-way waitpoint fan-out. A waitpoint that is not on its home/run store is
// resolved by probing the other stores: a cuid can only be drain-relocated between the two gen-1
// stores, and a gen-2 id names exactly one shard. Each scenario places the target on a store other
// than the run's own and asserts the router still finds/counts it.

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

// One gen-2 shard "a" alongside the gen-1 pair. The constructor derives probe/precedence order.
function build(stores: { legacy?: Held; new?: Held; a?: Held }) {
  return new RoutingRunStore({
    new: fakeStore("new", stores.new),
    legacy: fakeStore("legacy", stores.legacy),
    shards: [{ key: "a", store: fakeStore("a", stores.a) }],
    resolveShard,
  });
}

// A cuid waitpoint id resolves home to "legacy"; a gen-1 run id routes the run store to "new".
const CUID_WAITPOINT = "clabc123def456ghi789jkl01";

describe("RoutingRunStore N-way waitpoint fan-out", () => {
  it("resolves a cuid waitpoint that was drain-relocated onto the other gen-1 store", async () => {
    const store = build({ new: { waitpoints: [CUID_WAITPOINT] } });
    const row = await store.findWaitpoint({ where: { id: CUID_WAITPOINT } });
    expect(row).toMatchObject({ id: CUID_WAITPOINT, slot: "new" });
  });

  it("counts a pending cuid token on the other gen-1 store (never undercounts)", async () => {
    const runId = generateRunOpsId(); // gen-1 -> run store is "new"
    const store = build({ legacy: { waitpoints: [CUID_WAITPOINT], pending: [CUID_WAITPOINT] } });
    const count = await store.countPendingWaitpoints([CUID_WAITPOINT], undefined, runId);
    expect(count).toBe(1);
  });

  it("collects a gen-2 waitpoint that lives on its own shard, not the run's store", async () => {
    const runId = generateRunOpsId(); // gen-1 -> run store is "new"
    const shardWaitpoint = generateRunOpsIdV2("a"); // resolves to shard "a"
    const store = build({ a: { waitpoints: [shardWaitpoint] } });
    const rows = await store.findManyWaitpoints(
      { where: { id: { in: [shardWaitpoint] } } },
      undefined,
      runId
    );
    expect(rows).toEqual([{ id: shardWaitpoint, slot: "a" }]);
  });
});
