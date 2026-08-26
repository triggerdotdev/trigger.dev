import { describe, expect, it } from "vitest";
import { assertSnapshotStoreBoot } from "~/v3/snapshotStoreBoot.server";

type Recorded = { logs: string[]; warnings: string[]; pings: number };

function deps(overrides: Partial<Parameters<typeof assertSnapshotStoreBoot>[0]> = {}) {
  const recorded: Recorded = { logs: [], warnings: [], pings: 0 };
  const base = {
    mode: "off" as const,
    hostConfigured: false,
    completedTtlMs: 1,
    orphanAgeMs: 1,
    ping: async () => {
      recorded.pings += 1;
      return true;
    },
    repairBound: () => true,
    log: (message: string) => recorded.logs.push(message),
    warn: (message: string) => recorded.warnings.push(message),
  };
  return { ...base, ...overrides, recorded };
}

describe("assertSnapshotStoreBoot", () => {
  it("passes and logs when the dial is off and nothing is configured", async () => {
    const d = deps();
    await expect(assertSnapshotStoreBoot(d)).resolves.toBeUndefined();
    expect(d.recorded.logs).toHaveLength(1);
  });

  it("does not probe reachability at off", async () => {
    const d = deps();
    await expect(assertSnapshotStoreBoot(d)).resolves.toBeUndefined();
    expect(d.recorded.pings).toBe(0);
  });

  it("refuses a dial past off with no host", async () => {
    await expect(
      assertSnapshotStoreBoot(deps({ mode: "dual-write", hostConfigured: false }))
    ).rejects.toThrow(/RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST/);
  });

  it("refuses a non-positive TTL once the dial is past off", async () => {
    await expect(
      assertSnapshotStoreBoot(deps({ mode: "dual-write", hostConfigured: true, completedTtlMs: 0 }))
    ).rejects.toThrow(/COMPLETED_TTL_MS/);
    await expect(
      assertSnapshotStoreBoot(deps({ mode: "dual-write", hostConfigured: true, orphanAgeMs: -1 }))
    ).rejects.toThrow(/ORPHAN_AGE_MS/);
  });

  it("refuses when the repair binding is unset and the dial is past off", async () => {
    await expect(
      assertSnapshotStoreBoot(
        deps({ mode: "dual-write", hostConfigured: true, repairBound: () => false })
      )
    ).rejects.toThrow(/repair/i);
  });

  it("boots on an unreachable endpoint below redis-only, loudly", async () => {
    const d = deps({ mode: "dual-write", hostConfigured: true, ping: async () => false });
    await expect(assertSnapshotStoreBoot(d)).resolves.toBeUndefined();
    expect(d.recorded.warnings.length).toBeGreaterThan(0);
  });

  it("refuses an unreachable endpoint at redis-only", async () => {
    await expect(
      assertSnapshotStoreBoot(
        deps({ mode: "redis-only", hostConfigured: true, ping: async () => false })
      )
    ).rejects.toThrow(/unreachable/i);
  });

  it("warns at redis-only because this build still writes Postgres snapshots", async () => {
    const d = deps({ mode: "redis-only", hostConfigured: true });
    await expect(assertSnapshotStoreBoot(d)).resolves.toBeUndefined();
    expect(d.recorded.warnings.join(" ")).toMatch(/Postgres/i);
  });
});
