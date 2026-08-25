import { describe, expect, it } from "vitest";
// The entrypoint calls this file with plain `node`, so it takes no path alias and no bundler.
import { shardMigrationDsns } from "../../../docker/scripts/runOpsShardDsns.mjs";

const shardA = {
  key: "a",
  region: "us-east-1",
  url: "postgres://h/a",
  replication: { slotName: "sa", publicationName: "pa", originGeneration: 2 },
};

describe("shardMigrationDsns", () => {
  it("returns nothing when the variable is unset", () => {
    expect(shardMigrationDsns(undefined)).toEqual([]);
  });

  it("returns nothing when the variable is blank", () => {
    expect(shardMigrationDsns("   ")).toEqual([]);
  });

  it("returns nothing for an empty array", () => {
    expect(shardMigrationDsns("[]")).toEqual([]);
  });

  it("throws on invalid JSON, so the entrypoint stops before it migrates", () => {
    expect(() => shardMigrationDsns("{not json")).toThrow(/not valid JSON/i);
  });

  it("throws when the value is JSON but not an array", () => {
    expect(() => shardMigrationDsns('{"key":"a"}')).toThrow(/not a JSON array/i);
  });

  it("returns the url of a shard that owns its own database", () => {
    expect(shardMigrationDsns(JSON.stringify([shardA]))).toEqual(["postgres://h/a"]);
  });

  it("prefers directUrl over url, because migrations must not go through a pooler", () => {
    const withDirect = { ...shardA, directUrl: "postgres://h/a-direct" };
    expect(shardMigrationDsns(JSON.stringify([withDirect]))).toEqual(["postgres://h/a-direct"]);
  });

  it("skips an aliased shard, because its target's invocation already migrates it", () => {
    const aliased = { key: "z", region: "us-east-1", aliasOf: "new" };
    expect(shardMigrationDsns(JSON.stringify([shardA, aliased]))).toEqual(["postgres://h/a"]);
  });

  it("skips a descriptor with neither url nor directUrl", () => {
    const noUrl = { key: "b", region: "us-east-1" };
    expect(shardMigrationDsns(JSON.stringify([shardA, noUrl]))).toEqual(["postgres://h/a"]);
  });

  it("keeps declaration order across several shards", () => {
    const shardB = { ...shardA, key: "b", url: "postgres://h/b" };
    expect(shardMigrationDsns(JSON.stringify([shardA, shardB]))).toEqual([
      "postgres://h/a",
      "postgres://h/b",
    ]);
  });

  it("throws when an entry is not an object", () => {
    expect(() => shardMigrationDsns('["postgres://h/a"]')).toThrow(/not an object/i);
  });
});

describe("shardMigrationDsns line protocol", () => {
  // One DSN per line is the protocol with entrypoint.sh, so a line break would split one DSN into
  // two bogus ones. The URL parser strips ASCII line breaks, so nothing upstream rejects this.
  it("throws when a DSN holds a line break", () => {
    const bad = { key: "a", region: "r", url: "postgres://h/a\npostgres://evil/db" };
    expect(() => shardMigrationDsns(JSON.stringify([bad]))).toThrow(/line break/i);
  });

  it("throws when a directUrl holds a carriage return", () => {
    const bad = { key: "a", region: "r", url: "postgres://h/a", directUrl: "postgres://h/a\rx" };
    expect(() => shardMigrationDsns(JSON.stringify([bad]))).toThrow(/line break/i);
  });
});
