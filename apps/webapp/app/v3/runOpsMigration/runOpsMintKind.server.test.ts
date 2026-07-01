import { describe, expect, it, vi } from "vitest";
import { computeRunIdMintKind } from "./runOpsMintKind.server";

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

  it("mints cuid when split is OFF, even if master + per-org flag say ksuid", async () => {
    const flag = vi.fn().mockResolvedValue("ksuid");
    const kind = await computeRunIdMintKind(
      { organizationId: "org_1", id: "env_1" },
      { masterEnabled: true, splitEnabled: async () => false, flag }
    );
    expect(kind).toBe("cuid"); // the split-enabled gate dominates
    expect(flag).not.toHaveBeenCalled(); // split-off short-circuits before any flag read
  });

  it("mints ksuid only when master on AND split on AND per-org flag = ksuid", async () => {
    const flag = vi.fn().mockResolvedValue("ksuid");
    const kind = await computeRunIdMintKind(
      { organizationId: "org_1", id: "env_1" },
      { masterEnabled: true, splitEnabled: async () => true, flag }
    );
    expect(kind).toBe("ksuid");
  });

  it("passes the already-loaded org feature flags through to the flag fn (no extra DB read)", async () => {
    const flag = vi.fn().mockResolvedValue("ksuid");
    const orgFeatureFlags = { runOpsMintKsuid: "ksuid" };
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
