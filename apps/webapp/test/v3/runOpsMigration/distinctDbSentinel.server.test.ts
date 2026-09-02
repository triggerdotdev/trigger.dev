import { heteroPostgresTest } from "@internal/testcontainers";
import { PrismaClient } from "@trigger.dev/database";
import { describe, expect, it, vi } from "vitest";
import {
  probeDistinctDatabases,
  probeDistinctStores,
} from "~/v3/runOpsMigration/distinctDbSentinel.server";

// Spinning up two separate postgres clusters and probing each can exceed the 5s default.
vi.setConfig({ testTimeout: 60_000 });

function urlWithDatabase(uri: string, database: string): string {
  const url = new URL(uri);
  url.pathname = `/${database}`;
  return url.toString();
}

describe("probeDistinctDatabases", () => {
  heteroPostgresTest(
    "reports distinct for two separate physical clusters",
    async ({ uri14, uri17 }) => {
      const result = await probeDistinctDatabases(uri14, uri17);
      expect(result).toEqual({ distinct: true });
    }
  );

  heteroPostgresTest(
    "reports NOT distinct, citing the same physical database, when both URLs point at it",
    async ({ uri14 }) => {
      const result = await probeDistinctDatabases(uri14, uri14);
      expect(result.distinct).toBe(false);
      if (result.distinct === false) {
        expect(result.reason).toMatch(/same physical database/i);
      }
    }
  );

  heteroPostgresTest(
    "reports distinct for two databases in the SAME cluster",
    async ({ postgresContainer14, uri14 }) => {
      const otherDb = `sentinel_other_${Date.now()}`;
      const admin = new PrismaClient({
        datasources: {
          db: { url: urlWithDatabase(postgresContainer14.getConnectionUri(), "postgres") },
        },
      });
      try {
        await admin.$executeRawUnsafe(`CREATE DATABASE "${otherDb}"`);
      } finally {
        await admin.$disconnect();
      }

      const otherUrl = urlWithDatabase(uri14, otherDb);
      const result = await probeDistinctDatabases(uri14, otherUrl);
      expect(result).toEqual({ distinct: true });
    }
  );

  heteroPostgresTest(
    "fails closed to NOT distinct when a probe cannot reach a database",
    async ({ uri14 }) => {
      const unreachable = "postgresql://nobody:nobody@127.0.0.1:1/does_not_exist";
      const result = await probeDistinctDatabases(uri14, unreachable);
      expect(result.distinct).toBe(false);
    }
  );
});

// A transient failure on ONE store must not refuse the boot fleet-wide. The probe fails closed,
// so an unretried blip on any shard collapses the whole deployment to single-DB and the boot
// interlock then throws. Retry a bounded number of times, then fail closed exactly as before.
describe("probeDistinctStores bounded retry", () => {
  const fp = (sysId: string, db: string) => ({ systemIdentifier: sysId, databaseName: db });

  it("recovers when a transient failure clears within the retry budget", async () => {
    let calls = 0;
    const readFingerprint = vi.fn(async (url: string) => {
      calls++;
      if (calls === 2) throw new Error("ECONNREFUSED");
      return fp("sys", url);
    });
    const result = await probeDistinctStores(
      [
        { id: "new", url: "a" },
        { id: "shard-a", url: "b" },
      ],
      { readFingerprint, attempts: 3, sleep: async () => {} }
    );
    expect(result).toEqual({ distinct: true });
  });

  it("fails closed once the retry budget is exhausted", async () => {
    const readFingerprint = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await probeDistinctStores(
      [
        { id: "new", url: "a" },
        { id: "shard-a", url: "b" },
      ],
      { readFingerprint, attempts: 3, sleep: async () => {} }
    );
    expect(result).toMatchObject({ distinct: false });
  });

  it("bounds the attempts it makes", async () => {
    const readFingerprint = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await probeDistinctStores(
      [
        { id: "a", url: "a" },
        { id: "b", url: "b" },
      ],
      {
        readFingerprint,
        attempts: 3,
        sleep: async () => {},
      }
    );
    // 2 targets x 3 attempts each, and no more.
    expect(readFingerprint).toHaveBeenCalledTimes(6);
  });

  // A duplicate is a correct, final answer. Retrying it would delay every boot of a genuinely
  // misconfigured deployment for no benefit.
  it("does not retry a genuine duplicate", async () => {
    const readFingerprint = vi.fn(async () => fp("sys", "same"));
    const result = await probeDistinctStores(
      [
        { id: "new", url: "a" },
        { id: "shard-a", url: "b" },
      ],
      { readFingerprint, attempts: 3, sleep: async () => {} }
    );
    expect(result).toMatchObject({ distinct: false });
    expect(readFingerprint).toHaveBeenCalledTimes(2);
  });
});

describe("probeDistinctStores (set uniqueness at N)", () => {
  heteroPostgresTest(
    "reports distinct for two separate physical clusters",
    async ({ uri14, uri17 }) => {
      const result = await probeDistinctStores([
        { id: "legacy", url: uri14 },
        { id: "new", url: uri17 },
      ]);
      expect(result).toEqual({ distinct: true });
    }
  );

  heteroPostgresTest("reports distinct for a single target", async ({ uri14 }) => {
    const result = await probeDistinctStores([{ id: "legacy", url: uri14 }]);
    expect(result).toEqual({ distinct: true });
  });

  heteroPostgresTest("reports distinct for an empty target list", async () => {
    const result = await probeDistinctStores([]);
    expect(result).toEqual({ distinct: true });
  });

  heteroPostgresTest(
    "reports NOT distinct, naming both ids, when two targets resolve to one database",
    async ({ uri14, uri17 }) => {
      const result = await probeDistinctStores([
        { id: "legacy", url: uri14 },
        { id: "new", url: uri17 },
        { id: "shard-a", url: uri14 },
      ]);
      expect(result.distinct).toBe(false);
      if (result.distinct === false) {
        expect(result.reason).toMatch(/same physical database/i);
        expect(result.reason).toMatch(/legacy/);
        expect(result.reason).toMatch(/shard-a/);
      }
    }
  );

  // A pairwise implementation that only ever compares the first two targets passes every other
  // case in this file and fails this one: legacy vs new is clean, and the duplicate pair is
  // shard against shard on a third database.
  heteroPostgresTest(
    "catches a duplicate between two SHARDS while the gen-1 pair is clean",
    async ({ postgresContainer14, uri14, uri17 }) => {
      const shardDb = `sentinel_shard_dupe_${Date.now()}`;
      const admin = new PrismaClient({
        datasources: {
          db: { url: urlWithDatabase(postgresContainer14.getConnectionUri(), "postgres") },
        },
      });
      try {
        await admin.$executeRawUnsafe(`CREATE DATABASE "${shardDb}"`);
      } finally {
        await admin.$disconnect();
      }
      const shardUrl = urlWithDatabase(uri14, shardDb);

      const result = await probeDistinctStores([
        { id: "legacy", url: uri14 },
        { id: "new", url: uri17 },
        { id: "shard-a", url: shardUrl },
        { id: "shard-b", url: shardUrl },
      ]);
      expect(result.distinct).toBe(false);
      if (result.distinct === false) {
        expect(result.reason).toMatch(/shard-a/);
        expect(result.reason).toMatch(/shard-b/);
      }
    }
  );

  heteroPostgresTest(
    "reports distinct for two databases in the SAME cluster",
    async ({ postgresContainer14, uri14, uri17 }) => {
      const otherDb = `sentinel_set_other_${Date.now()}`;
      const admin = new PrismaClient({
        datasources: {
          db: { url: urlWithDatabase(postgresContainer14.getConnectionUri(), "postgres") },
        },
      });
      try {
        await admin.$executeRawUnsafe(`CREATE DATABASE "${otherDb}"`);
      } finally {
        await admin.$disconnect();
      }

      const result = await probeDistinctStores([
        { id: "legacy", url: uri14 },
        { id: "new", url: uri17 },
        { id: "shard-a", url: urlWithDatabase(uri14, otherDb) },
      ]);
      expect(result).toEqual({ distinct: true });
    }
  );

  heteroPostgresTest(
    "fails closed to NOT distinct when one target cannot be reached",
    async ({ uri14, uri17 }) => {
      const unreachable = "postgresql://nobody:nobody@127.0.0.1:1/does_not_exist";
      const result = await probeDistinctStores([
        { id: "legacy", url: uri14 },
        { id: "new", url: uri17 },
        { id: "shard-a", url: unreachable },
      ]);
      expect(result.distinct).toBe(false);
    }
  );
});
