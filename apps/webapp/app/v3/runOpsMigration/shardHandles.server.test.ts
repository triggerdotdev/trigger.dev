import { describe, expect, it } from "vitest";
import { buildShardHandleMaps } from "./shardHandles.server";

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
