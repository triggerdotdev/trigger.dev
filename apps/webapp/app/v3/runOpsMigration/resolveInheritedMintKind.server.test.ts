import { describe, expect, it, vi } from "vitest";
import { resolveInheritedMintKind } from "./resolveInheritedMintKind.server";

const NEW_PARENT = `run_${"a".repeat(27)}`; // ksuid id-shape -> NEW
const LEGACY_PARENT = `run_${"b".repeat(25)}`; // cuid id-shape -> LEGACY

describe("resolveInheritedMintKind (pure, shared across all mint paths)", () => {
  it("inherits a ksuid (NEW) parent by id-shape, split off, marker never read", async () => {
    const isKnownMigrated = vi.fn();
    const kind = await resolveInheritedMintKind(NEW_PARENT, {
      isSplitEnabled: async () => false,
      isKnownMigrated,
    });
    expect(kind).toBe("ksuid");
    expect(isKnownMigrated).not.toHaveBeenCalled();
  });

  it("inherits a cuid (LEGACY) parent by id-shape, split off, marker never read", async () => {
    const isKnownMigrated = vi.fn();
    const kind = await resolveInheritedMintKind(LEGACY_PARENT, {
      isSplitEnabled: async () => false,
      isKnownMigrated,
    });
    expect(kind).toBe("cuid");
    expect(isKnownMigrated).not.toHaveBeenCalled();
  });

  // The gap this helper closes: split OFF = one physical DB, and a probeNew-backed
  // isKnownMigrated returns true for any extant parent. The guard must skip the marker
  // when split is off so a cuid parent keeps minting cuid children (byte-identical to today).
  it("does NOT consult the marker when split is OFF (hot-path zero-IO; byte-identical to today)", async () => {
    const isKnownMigrated = vi.fn().mockResolvedValue(true);
    const kind = await resolveInheritedMintKind(LEGACY_PARENT, {
      isSplitEnabled: async () => false,
      isKnownMigrated,
    });
    expect(kind).toBe("cuid");
    expect(isKnownMigrated).not.toHaveBeenCalled();
  });

  it("split ON + legacy-by-shape parent already migrated (marker true) -> ksuid (co-resident on NEW)", async () => {
    const kind = await resolveInheritedMintKind(LEGACY_PARENT, {
      isSplitEnabled: async () => true,
      isKnownMigrated: async () => true,
    });
    expect(kind).toBe("ksuid");
  });

  it("split ON + legacy-by-shape parent NOT migrated (marker false) -> cuid (stays LEGACY)", async () => {
    const kind = await resolveInheritedMintKind(LEGACY_PARENT, {
      isSplitEnabled: async () => true,
      isKnownMigrated: async () => false,
    });
    expect(kind).toBe("cuid");
  });

  it("split ON + ksuid parent -> ksuid regardless of marker (already NEW)", async () => {
    const kind = await resolveInheritedMintKind(NEW_PARENT, {
      isSplitEnabled: async () => true,
      isKnownMigrated: async () => false,
    });
    expect(kind).toBe("ksuid");
  });
});
