import { describe, expect, it } from "vitest";
import { buildShardHandleMaps, nonAliasedShardReplicas } from "./shardHandles.server";

// Two distinct sentinels per shard: the maps must not cross writer and replica.
function handle(key: string) {
  return {
    key,
    writer: { tag: `${key}-writer` } as never,
    replica: { tag: `${key}-replica` } as never,
  };
}

describe("buildShardHandleMaps", () => {
  it("yields empty maps when no shard is configured", () => {
    const { replicas, writers } = buildShardHandleMaps([]);

    expect(replicas.size).toBe(0);
    expect(writers.size).toBe(0);
  });

  it("keys each shard's replica and writer under its shard char", () => {
    const { replicas, writers } = buildShardHandleMaps([handle("a"), handle("b")]);

    expect([...replicas.keys()].sort()).toEqual(["a", "b"]);
    expect([...writers.keys()].sort()).toEqual(["a", "b"]);
    expect(replicas.get("a")).toEqual({ tag: "a-replica" });
    expect(writers.get("a")).toEqual({ tag: "a-writer" });
    expect(replicas.get("b")).toEqual({ tag: "b-replica" });
    expect(writers.get("b")).toEqual({ tag: "b-writer" });
  });

  it("never places a writer in the replica map", () => {
    const { replicas } = buildShardHandleMaps([handle("a")]);

    expect(replicas.get("a")).not.toEqual({ tag: "a-writer" });
  });
});

describe("nonAliasedShardReplicas", () => {
  it("yields an empty list when no shard is configured", () => {
    expect(nonAliasedShardReplicas([])).toEqual([]);
  });

  it("keeps the configured order and carries each shard's replica", () => {
    expect(nonAliasedShardReplicas([handle("b"), handle("a")])).toEqual([
      { key: "b", replica: { tag: "b-replica" } },
      { key: "a", replica: { tag: "a-replica" } },
    ]);
  });

  // An aliased shard shares its target's client BY REFERENCE, so a leg for it scans one database
  // twice. The router drops it the same way, on the DECLARATION rather than object identity.
  it("drops a shard that declares aliasOf", () => {
    expect(nonAliasedShardReplicas([{ ...handle("a"), aliasOf: "new" }, handle("b")])).toEqual([
      { key: "b", replica: { tag: "b-replica" } },
    ]);
  });

  it("never carries a writer in place of a replica", () => {
    expect(nonAliasedShardReplicas([handle("a")])[0]?.replica).not.toEqual({ tag: "a-writer" });
  });
});
