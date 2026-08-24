import { describe, expect, it } from "vitest";
import {
  generateRunOpsId,
  generateRunOpsIdV2,
  resolveShard,
  type ShardKey,
} from "@trigger.dev/core/v3/isomorphic";
import { RoutingRunStore, UnknownShardKey } from "./runOpsStore.js";
import type { ReadClient, RunStore } from "./types.js";

// Pure routing unit test for the N-way fromShards factory. Each shard is a fake RunStore whose
// findRun records which slot answered, so the assertions are purely about WHICH store the router
// selects. No database.
type FakeStore = RunStore & { slot: ShardKey };

function fakeStore(slot: ShardKey): FakeStore {
  const store: Partial<FakeStore> = {
    slot,
    primaryReadClient: { __primary: slot } as unknown as ReadClient,
    findRun: ((_where: unknown, _argsOrClient?: unknown, _client?: unknown) =>
      Promise.resolve({ slot } as never)) as FakeStore["findRun"],
  };
  return store as FakeStore;
}

function build(shardKeys: ShardKey[]) {
  const shards = new Map<ShardKey, RunStore>();
  shards.set("legacy", fakeStore("legacy"));
  shards.set("new", fakeStore("new"));
  for (const k of shardKeys) shards.set(k, fakeStore(k));
  return RoutingRunStore.fromShards({
    shards,
    probeOrder: ["new", ...shardKeys, "legacy"],
    precedence: ["legacy", "new", ...shardKeys],
    idlessRouteShard: "new",
    idlessWaitpointShard: "legacy",
    resolveShardKey: resolveShard,
  });
}

describe("RoutingRunStore.fromShards", () => {
  it("routes a gen-2 id to its own shard, not to new", async () => {
    const store = build(["a"]);
    const found = await store.findRun({ friendlyId: generateRunOpsIdV2("a") });
    expect(found).toMatchObject({ slot: "a" });
  });

  it("routes a gen-1 v1 id to new", async () => {
    const store = build(["a"]);
    const found = await store.findRun({ friendlyId: generateRunOpsId() });
    expect(found).toMatchObject({ slot: "new" });
  });

  it("routes a cuid id to legacy", async () => {
    const store = build(["a"]);
    const found = await store.findRun({ friendlyId: "clabc123def456ghi789jkl01" });
    expect(found).toMatchObject({ slot: "legacy" });
  });

  it("raises UnknownShardKey for an unconfigured shard and does not fall back", () => {
    const store = build(["a"]); // "b" is not configured
    // The route resolves synchronously, so the throw is synchronous (before the promise is built).
    expect(() => store.findRun({ friendlyId: generateRunOpsIdV2("b") })).toThrow(UnknownShardKey);
  });
});
