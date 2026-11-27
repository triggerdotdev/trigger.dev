import { describe, expect, it, vi } from "vitest";
import { computeRunIdMintKind, isFlipGraceTooShort } from "./runOpsMintKind.server";

describe("computeRunIdMintKind (pure)", () => {
  it("mints cuid when the master switch is off (never reads the flag)", async () => {
    const flag = vi.fn();
    const kind = await computeRunIdMintKind(
      { organizationId: "org_1", id: "env_1" },
      { masterEnabled: false, splitEnabled: async () => true, flag }
    );
    expect(kind).toBe("cuid");
    expect(flag).not.toHaveBeenCalled();
  });

  it("mints cuid when split is OFF, even if master + per-org flag say 'runOpsId'", async () => {
    const flag = vi.fn().mockResolvedValue("runOpsId");
    const kind = await computeRunIdMintKind(
      { organizationId: "org_1", id: "env_1" },
      { masterEnabled: true, splitEnabled: async () => false, flag }
    );
    expect(kind).toBe("cuid"); // the split-enabled gate dominates
    expect(flag).not.toHaveBeenCalled(); // split-off short-circuits before any flag read
  });

  it("mints run-ops id only when master on AND split on AND per-org flag = 'runOpsId'", async () => {
    const flag = vi.fn().mockResolvedValue("runOpsId");
    const kind = await computeRunIdMintKind(
      { organizationId: "org_1", id: "env_1" },
      { masterEnabled: true, splitEnabled: async () => true, flag }
    );
    expect(kind).toBe("runOpsId");
  });

  it("passes the already-loaded org feature flags through to the flag fn (no extra DB read)", async () => {
    const flag = vi.fn().mockResolvedValue("runOpsId");
    const orgFeatureFlags = { runOpsMintKind: "runOpsId" };
    await computeRunIdMintKind(
      { organizationId: "org_1", id: "env_1", orgFeatureFlags },
      { masterEnabled: true, splitEnabled: async () => true, flag }
    );
    expect(flag).toHaveBeenCalledWith("org_1", orgFeatureFlags);
  });

  it("mints cuid for a non-canary org (per-org flag defaults to cuid)", async () => {
    const flag = vi.fn().mockResolvedValue("cuid");
    const kind = await computeRunIdMintKind(
      { organizationId: "org_2", id: "env_2" },
      { masterEnabled: true, splitEnabled: async () => true, flag }
    );
    expect(kind).toBe("cuid");
  });

  it("fails safe to cuid when the flag read throws", async () => {
    const flag = vi.fn().mockRejectedValue(new Error("db down"));
    const kind = await computeRunIdMintKind(
      { organizationId: "org_1", id: "env_1" },
      { masterEnabled: true, splitEnabled: async () => true, flag }
    );
    expect(kind).toBe("cuid"); // never arm a mint on a flag-read failure
  });
});

describe("isFlipGraceTooShort (pure)", () => {
  // Catches: the boot check leaving the global flags' reload interval out of the sum.
  it("counts the global flags' reload interval with the two cache lifetimes", () => {
    const caches = { mintFlagCacheTtlMs: 30_000, controlPlaneCacheTtlMs: 30_000 };
    expect(
      isFlipGraceTooShort({ graceMs: 90_000, ...caches, globalFlagsReloadIntervalMs: 5_000 })
    ).toBe(false);
    expect(
      isFlipGraceTooShort({ graceMs: 90_000, ...caches, globalFlagsReloadIntervalMs: 31_000 })
    ).toBe(true);
    // At most: a grace equal to the sum is too short.
    expect(
      isFlipGraceTooShort({ graceMs: 90_000, ...caches, globalFlagsReloadIntervalMs: 30_000 })
    ).toBe(true);
  });
});
