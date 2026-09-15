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

  it("rejects a descriptor with neither url nor aliasOf", () => {
    const noUrl = { key: "b", region: "us-east-1" };
    expect(() => shardMigrationDsns(JSON.stringify([shardA, noUrl]))).toThrow(/exactly one/i);
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
    const bad = { ...shardA, url: "postgres://h/a\npostgres://evil/db" };
    expect(() => shardMigrationDsns(JSON.stringify([bad]))).toThrow(/line break/i);
  });

  it("throws when a directUrl holds a carriage return", () => {
    const bad = { ...shardA, directUrl: "postgres://h/a\rx" };
    expect(() => shardMigrationDsns(JSON.stringify([bad]))).toThrow(/line break/i);
  });
});

// The script and the boot schema validate the same variable, so they must agree. If the script is
// laxer, the entrypoint migrates a database and the application then refuses to start, which breaks
// the fail-before-migration contract the entrypoint exists to hold.
describe("shardMigrationDsns matches the descriptor contract", () => {
  it("rejects an aliasOf value the schema does not allow", () => {
    const bad = [{ key: "a", region: "r", url: "postgres://h/a", aliasOf: "other" }];
    expect(() => shardMigrationDsns(JSON.stringify(bad))).toThrow(/aliasOf/i);
  });

  it("rejects a shard that owns its database but declares no replication", () => {
    const bad = [{ key: "b", region: "r", url: "postgres://h/b" }];
    expect(() => shardMigrationDsns(JSON.stringify(bad))).toThrow(/replication/i);
  });

  it("rejects a descriptor that sets both url and aliasOf", () => {
    const bad = [{ key: "c", region: "r", url: "postgres://h/c", aliasOf: "new" }];
    expect(() => shardMigrationDsns(JSON.stringify(bad))).toThrow(/exactly one/i);
  });

  it("rejects a descriptor that sets neither url nor aliasOf", () => {
    const bad = [{ key: "d", region: "r" }];
    expect(() => shardMigrationDsns(JSON.stringify(bad))).toThrow(/exactly one/i);
  });

  it("still accepts a valid aliased descriptor and skips it", () => {
    const ok = [{ key: "z", region: "r", aliasOf: "new" }];
    expect(shardMigrationDsns(JSON.stringify(ok))).toEqual([]);
  });

  it("still accepts a valid owning descriptor", () => {
    expect(shardMigrationDsns(JSON.stringify([shardA]))).toEqual(["postgres://h/a"]);
  });
});

// The boot schema URL-validates url, replicaUrl and directUrl with isValidDatabaseUrl. The script
// must not be laxer, or a valid descriptor ahead of an invalid one gets its database migrated before
// the configuration is rejected.
describe("shardMigrationDsns validates descriptor values", () => {
  const rep = { slotName: "s", publicationName: "p", originGeneration: 2 };

  it("rejects a url that is not a parseable URL", () => {
    const bad = [{ key: "a", region: "r", url: "not a URL", replication: rep }];
    expect(() => shardMigrationDsns(JSON.stringify(bad))).toThrow(/url/i);
  });

  it("rejects a directUrl that is not a parseable URL", () => {
    const bad = [
      { key: "a", region: "r", url: "postgres://h/a", directUrl: "nope", replication: rep },
    ];
    expect(() => shardMigrationDsns(JSON.stringify(bad))).toThrow(/directUrl/i);
  });

  it("rejects a replicaUrl that is not a parseable URL", () => {
    const bad = [
      { key: "a", region: "r", url: "postgres://h/a", replicaUrl: "nope", replication: rep },
    ];
    expect(() => shardMigrationDsns(JSON.stringify(bad))).toThrow(/replicaUrl/i);
  });

  it("rejects an empty schema search param, matching the boot schema", () => {
    const bad = [{ key: "a", region: "r", url: "postgres://h/a?schema=", replication: rep }];
    expect(() => shardMigrationDsns(JSON.stringify(bad))).toThrow(/url/i);
  });

  it("rejects a multi-char shard key", () => {
    const bad = [{ key: "ab", region: "r", url: "postgres://h/a", replication: rep }];
    expect(() => shardMigrationDsns(JSON.stringify(bad))).toThrow(/key/i);
  });

  it("rejects an origin generation outside 2..255", () => {
    for (const gen of [1, 256]) {
      const bad = [
        {
          key: "a",
          region: "r",
          url: "postgres://h/a",
          replication: { ...rep, originGeneration: gen },
        },
      ];
      expect(() => shardMigrationDsns(JSON.stringify(bad))).toThrow(/originGeneration/i);
    }
  });

  it("rejects a replication block with a blank slot name", () => {
    const bad = [
      { key: "a", region: "r", url: "postgres://h/a", replication: { ...rep, slotName: "" } },
    ];
    expect(() => shardMigrationDsns(JSON.stringify(bad))).toThrow(/slotName/i);
  });

  // The failure must come BEFORE any DSN is handed back, so no database is migrated first.
  it("emits nothing when a later descriptor is invalid", () => {
    const mixed = [
      { key: "a", region: "r", url: "postgres://h/a", replication: rep },
      { key: "b", region: "r", url: "not a URL", replication: { ...rep, originGeneration: 3 } },
    ];
    expect(() => shardMigrationDsns(JSON.stringify(mixed))).toThrow(/url/i);
  });

  it("still accepts a fully valid descriptor with all three URLs", () => {
    const ok = [
      {
        key: "a",
        region: "r",
        url: "postgres://h/a?schema=public",
        replicaUrl: "postgres://h/a-replica?schema=public",
        directUrl: "postgres://h/a-direct?schema=public",
        replication: rep,
      },
    ];
    expect(shardMigrationDsns(JSON.stringify(ok))).toEqual(["postgres://h/a-direct?schema=public"]);
  });
});
