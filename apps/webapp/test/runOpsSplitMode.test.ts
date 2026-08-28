import { describe, expect, it, vi } from "vitest";
// @testcontainers/postgresql resolves because it is declared in apps/webapp/package.json.
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import {
  computeSplitEnabled,
  assertShardsRequireSplit,
  assertSplitRealtimeInterlock,
} from "~/v3/runOpsMigration/splitMode.server";
import { probeDistinctDatabases } from "~/v3/runOpsMigration/distinctDbSentinel.server";

describe("computeSplitEnabled (pure)", () => {
  it("is OFF by default and never probes when the flag is off", async () => {
    const probe = vi.fn();
    const result = await computeSplitEnabled(
      { flagEnabled: false, legacyUrl: "postgres://a", newUrl: "postgres://b" },
      { probe }
    );
    expect(result).toBe(false);
    expect(probe).not.toHaveBeenCalled(); // self-host opens no second connection
  });

  it("stays single-DB when flag is on but URLs are missing", async () => {
    const probe = vi.fn();
    expect(await computeSplitEnabled({ flagEnabled: true }, { probe })).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("enables split only when flag is on AND sentinel confirms distinct", async () => {
    const probe = vi.fn().mockResolvedValue({ distinct: true });
    expect(
      await computeSplitEnabled(
        { flagEnabled: true, legacyUrl: "postgres://a", newUrl: "postgres://b" },
        { probe }
      )
    ).toBe(true);
  });

  it("stays single-DB when sentinel reports NOT distinct", async () => {
    const probe = vi.fn().mockResolvedValue({ distinct: false, reason: "same DB" });
    expect(
      await computeSplitEnabled(
        { flagEnabled: true, legacyUrl: "postgres://a", newUrl: "postgres://b" },
        { probe }
      )
    ).toBe(false);
  });

  // Migration-family unreachability proof: with the flag off the gate returns false and
  // no probe runs. Downstream migration-family code is required to early-return on
  // !isSplitEnabled(); this unit proves the gate's value, each downstream unit's own test
  // proves it honors the gate. Split OFF collapsing to a single prisma/$replica pair with
  // no second connection opened depends on this no-probe behavior.
  it("is provably unreachable (no probe) when the flag is off", async () => {
    const probe = vi.fn();
    expect(
      await computeSplitEnabled(
        { flagEnabled: false, legacyUrl: "postgres://a", newUrl: "postgres://b" },
        { probe }
      )
    ).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("computeSplitEnabled shard targets", () => {
  const shardA = { key: "a", url: "postgres://shard-a" };
  const shardB = { key: "b", url: "postgres://shard-b" };

  it("probes the gen-1 pair only when no shard is configured", async () => {
    const probe = vi.fn().mockResolvedValue({ distinct: true });
    await computeSplitEnabled(
      { flagEnabled: true, legacyUrl: "postgres://a", newUrl: "postgres://b" },
      { probe }
    );
    expect(probe).toHaveBeenCalledWith(
      [
        { id: "legacy", url: "postgres://a" },
        { id: "new", url: "postgres://b" },
      ],
      expect.anything()
    );
  });

  it("appends one target per shard, keyed by shard id", async () => {
    const probe = vi.fn().mockResolvedValue({ distinct: true });
    await computeSplitEnabled(
      {
        flagEnabled: true,
        legacyUrl: "postgres://a",
        newUrl: "postgres://b",
        shards: [shardA, shardB],
      },
      { probe }
    );
    expect(probe).toHaveBeenCalledWith(
      [
        { id: "legacy", url: "postgres://a" },
        { id: "new", url: "postgres://b" },
        { id: "shard-a", url: "postgres://shard-a" },
        { id: "shard-b", url: "postgres://shard-b" },
      ],
      expect.anything()
    );
  });

  it("stays single-DB when a shard duplicates another store", async () => {
    const probe = vi.fn().mockResolvedValue({ distinct: false, reason: "same DB" });
    expect(
      await computeSplitEnabled(
        {
          flagEnabled: true,
          legacyUrl: "postgres://a",
          newUrl: "postgres://b",
          shards: [shardA],
        },
        { probe }
      )
    ).toBe(false);
  });

  it("never probes a shard when the flag is off", async () => {
    const probe = vi.fn();
    await computeSplitEnabled(
      {
        flagEnabled: false,
        legacyUrl: "postgres://a",
        newUrl: "postgres://b",
        shards: [shardA],
      },
      { probe }
    );
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("assertSplitRealtimeInterlock (pure)", () => {
  it("throws when split is on but the native realtime backend is off", () => {
    expect(() =>
      assertSplitRealtimeInterlock({ splitEnabled: true, nativeRealtimeEnabled: false })
    ).toThrowError(/native realtime backend|REALTIME_BACKEND_NATIVE_ENABLED/i);
  });

  it("does not throw when split is on and the native realtime backend is on", () => {
    expect(() =>
      assertSplitRealtimeInterlock({ splitEnabled: true, nativeRealtimeEnabled: true })
    ).not.toThrow();
  });

  it("does not throw when split is off, regardless of the native realtime backend", () => {
    expect(() =>
      assertSplitRealtimeInterlock({ splitEnabled: false, nativeRealtimeEnabled: false })
    ).not.toThrow();
    expect(() =>
      assertSplitRealtimeInterlock({ splitEnabled: false, nativeRealtimeEnabled: true })
    ).not.toThrow();
  });
});

describe("assertShardsRequireSplit (pure)", () => {
  it("allows shards when the split flag is on", () => {
    expect(() =>
      assertShardsRequireSplit({ splitFlagEnabled: true, shardKeys: ["a"] })
    ).not.toThrow();
  });

  it("allows the split flag off when no shard is configured", () => {
    expect(() =>
      assertShardsRequireSplit({ splitFlagEnabled: false, shardKeys: [] })
    ).not.toThrow();
  });

  // Shards are only ever built on the split-on arm of selectRunOpsTopology, so configuring one
  // while the split flag is off silently drops it: no shard client, no shard leg, and any row
  // already resident on that database disappears from every list with no error.
  it("refuses to boot when a shard is configured but the split flag is off", () => {
    expect(() =>
      assertShardsRequireSplit({ splitFlagEnabled: false, shardKeys: ["a", "b"] })
    ).toThrow(/RUN_OPS_SHARDS/);
  });

  it("names the configured shards so the operator can see which were dropped", () => {
    expect(() =>
      assertShardsRequireSplit({ splitFlagEnabled: false, shardKeys: ["a", "b"] })
    ).toThrow(/a, b/);
  });
});

describe("distinct-DB sentinel (real Postgres)", () => {
  it("reports NOT distinct when both URLs hit the same physical cluster", async () => {
    const pg = await new PostgreSqlContainer("docker.io/postgres:14").start();
    try {
      const url = pg.getConnectionUri();
      const result = await probeDistinctDatabases(url, url);
      expect(result.distinct).toBe(false); // identical URL -> false-split prevented
    } finally {
      await pg.stop();
    }
  }, 60_000);

  it("reports distinct when URLs hit two separate clusters (legacy + new)", async () => {
    const legacy = await new PostgreSqlContainer("docker.io/postgres:14").start();
    const next = await new PostgreSqlContainer("docker.io/postgres:17").start();
    try {
      const result = await probeDistinctDatabases(
        legacy.getConnectionUri(),
        next.getConnectionUri()
      );
      expect(result.distinct).toBe(true);
    } finally {
      await legacy.stop();
      await next.stop();
    }
  }, 120_000);

  it("fails closed (single-DB) when a DB is unreachable", async () => {
    const result = await probeDistinctDatabases(
      "postgresql://nouser:nopass@127.0.0.1:1/none",
      "postgresql://nouser:nopass@127.0.0.1:2/none"
    );
    expect(result.distinct).toBe(false);
  }, 30_000);
});
