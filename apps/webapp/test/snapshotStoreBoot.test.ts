import { describe, expect, it } from "vitest";
import { assertSnapshotStoreBoot } from "~/v3/snapshotStoreBoot.server";

type Recorded = {
  logs: string[];
  warnings: string[];
  pings: number;
  policyProbes: number;
};

function deps(overrides: Partial<Parameters<typeof assertSnapshotStoreBoot>[0]> = {}) {
  const recorded: Recorded = { logs: [], warnings: [], pings: 0, policyProbes: 0 };
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
    evictionPolicy: async () => {
      recorded.policyProbes += 1;
      return { kind: "known" as const, nodes: [{ node: "primary", policy: "noeviction" }] };
    },
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

  it("refuses a dial past off when the endpoint evicts keys", async () => {
    await expect(
      assertSnapshotStoreBoot(
        deps({
          mode: "dual-write",
          hostConfigured: true,
          evictionPolicy: async () => ({
            kind: "known",
            nodes: [{ node: "primary", policy: "allkeys-lru" }],
          }),
        })
      )
    ).rejects.toThrow(/noeviction/i);
  });

  it("refuses when any one cluster node evicts", async () => {
    await expect(
      assertSnapshotStoreBoot(
        deps({
          mode: "redis-read",
          hostConfigured: true,
          evictionPolicy: async () => ({
            kind: "known",
            nodes: [
              { node: "10.0.0.1:6379", policy: "noeviction" },
              { node: "10.0.0.2:6379", policy: "volatile-ttl" },
            ],
          }),
        })
      )
    ).rejects.toThrow(/10\.0\.0\.2:6379/);
  });

  it("passes when every node reports noeviction", async () => {
    const d = deps({ mode: "redis-read", hostConfigured: true });
    await expect(assertSnapshotStoreBoot(d)).resolves.toBeUndefined();
    expect(d.recorded.policyProbes).toBe(1);
    expect(d.recorded.warnings).toHaveLength(0);
  });

  it("warns rather than refusing when the policy cannot be read", async () => {
    const d = deps({
      mode: "redis-read",
      hostConfigured: true,
      evictionPolicy: async () => ({ kind: "unknown", reason: "CONFIG GET is disabled" }),
    });
    await expect(assertSnapshotStoreBoot(d)).resolves.toBeUndefined();
    expect(d.recorded.warnings.join(" ")).toMatch(/maxmemory-policy/i);
  });

  it("warns rather than refusing when no node reported a policy", async () => {
    const d = deps({
      mode: "redis-read",
      hostConfigured: true,
      evictionPolicy: async () => ({ kind: "known", nodes: [] }),
    });
    await expect(assertSnapshotStoreBoot(d)).resolves.toBeUndefined();
    expect(d.recorded.warnings.join(" ")).toMatch(/maxmemory-policy/i);
  });

  it("does not probe the policy at off", async () => {
    const d = deps();
    await expect(assertSnapshotStoreBoot(d)).resolves.toBeUndefined();
    expect(d.recorded.policyProbes).toBe(0);
  });

  it("does not probe the policy when the endpoint is unreachable", async () => {
    const d = deps({ mode: "dual-write", hostConfigured: true, ping: async () => false });
    await expect(assertSnapshotStoreBoot(d)).resolves.toBeUndefined();
    expect(d.recorded.policyProbes).toBe(0);
  });

  it("warns at redis-only because this build still writes Postgres snapshots", async () => {
    const d = deps({ mode: "redis-only", hostConfigured: true });
    await expect(assertSnapshotStoreBoot(d)).resolves.toBeUndefined();
    expect(d.recorded.warnings.join(" ")).toMatch(/Postgres/i);
  });

  it("validates the configuration whenever a host is set, not only past off", async () => {
    // The per-organisation override can put one organisation at dual-write while the deployment dial
    // is still off, which is how the ramp starts. Keying these assertions on the deployment dial
    // therefore lets a ramped organisation run on a configuration nothing checked.
    await expect(
      assertSnapshotStoreBoot(deps({ mode: "off", hostConfigured: true, completedTtlMs: 0 }))
    ).rejects.toThrow(/COMPLETED_TTL_MS/);

    await expect(
      assertSnapshotStoreBoot(deps({ mode: "off", hostConfigured: true, orphanAgeMs: -1 }))
    ).rejects.toThrow(/ORPHAN_AGE_MS/);

    await expect(
      assertSnapshotStoreBoot(deps({ mode: "off", hostConfigured: true, repairBound: () => false }))
    ).rejects.toThrow(/repair/i);
  });

  it("still asks nothing of an unconfigured deployment", async () => {
    const d = deps({ mode: "off", hostConfigured: false, completedTtlMs: 0, orphanAgeMs: -1 });
    await expect(assertSnapshotStoreBoot(d)).resolves.toBeUndefined();
  });
});
