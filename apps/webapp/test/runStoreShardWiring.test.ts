import { describe, expect, it } from "vitest";
import {
  MEMORYDB_SHARD_KEY,
  RoutingRunStore,
  UnknownShardKey,
  type RunStore,
} from "@internal/run-store";
import { generateRunOpsIdV2 } from "@trigger.dev/core/v3/isomorphic";
import { buildRunStore } from "~/v3/runStore.server";

// Construction-only: buildRunStore wraps clients but never connects, so stub handles suffice. This
// asserts the wiring shape (compat router vs N-way router), not query behaviour.
const stub = () => ({}) as any;

const baseSplit = {
  splitEnabled: true as const,
  newWriter: stub(),
  newReplica: stub(),
  legacyWriter: stub(),
  legacyReplica: stub(),
  singleWriter: stub(),
  singleReplica: stub(),
};

describe("buildRunStore shard wiring", () => {
  it("split ON with no shards builds the two-store compat router", () => {
    const store = buildRunStore(baseSplit);
    expect(store).toBeInstanceOf(RoutingRunStore);
  });

  it("split ON with two shard descriptors builds the N-way router", () => {
    const store = buildRunStore({
      ...baseSplit,
      shards: [
        { key: "a", writer: stub(), replica: stub() },
        { key: "b", writer: stub(), replica: stub() },
      ],
    });
    expect(store).toBeInstanceOf(RoutingRunStore);
  });

  it("split OFF builds the single-store passthrough (not a router)", () => {
    const store = buildRunStore({
      splitEnabled: false,
      singleWriter: stub(),
      singleReplica: stub(),
    });
    expect(store).not.toBeInstanceOf(RoutingRunStore);
  });
});

describe("buildRunStore MemoryDB slot", () => {
  const standIn = (calls: string[]) =>
    ({
      findRun: async () => {
        calls.push("findRun");
        return null;
      },
    }) as unknown as RunStore;

  // Catches: the memoryDbStore dep not registered, or registered under a key other than m.
  it("registers memoryDbStore under m, with or without configured shards", async () => {
    for (const shards of [undefined, [{ key: "a", writer: stub(), replica: stub() }]]) {
      const calls: string[] = [];
      const store = buildRunStore({ ...baseSplit, shards, memoryDbStore: standIn(calls) });
      await store.findRun({ id: generateRunOpsIdV2(MEMORYDB_SHARD_KEY) });
      expect({ shards: shards?.length ?? 0, calls }).toEqual({
        shards: shards?.length ?? 0,
        calls: ["findRun"],
      });
    }
  });

  // Catches: the slot decorated, given an alias, or placed before the configured shards.
  it("registers memoryDbStore as passed: undecorated, unaliased, after the configured shards", async () => {
    const decorated: string[] = [];
    const leafRows = (key: string) =>
      ({
        findRuns: async () => (key === "shard:a" ? [{ id: "dup", from: "a" }] : []),
      }) as unknown as RunStore;
    const found = { id: "found" };
    const standIn = {
      findRun: async () => found,
      findRuns: async () => [{ id: "dup", from: "m" }],
    } as unknown as RunStore;

    const store = buildRunStore({
      ...baseSplit,
      shards: [{ key: "a", writer: stub(), replica: stub() }],
      decorateLeaf: (_leaf, route) => {
        decorated.push(route);
        return leafRows(route);
      },
      memoryDbStore: standIn,
    });

    expect(decorated).toEqual(["new", "legacy", "shard:a"]);
    expect(await store.findRun({ id: generateRunOpsIdV2(MEMORYDB_SHARD_KEY) })).toBe(found);
    // A merge keeps the row from the store last in precedence; an aliased store is not asked.
    expect(await store.findRuns({ where: { status: "PENDING" } })).toEqual([
      { id: "dup", from: "m" },
    ]);
  });

  // Catches: a store under m registered when no memoryDbStore is passed.
  it("without memoryDbStore, a generation 3 id names an unconfigured key", () => {
    const store = buildRunStore(baseSplit);
    let thrown: unknown;
    try {
      store.findRun({ id: generateRunOpsIdV2(MEMORYDB_SHARD_KEY) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnknownShardKey);
    expect((thrown as UnknownShardKey).shardKey).toBe("m");
  });
});
