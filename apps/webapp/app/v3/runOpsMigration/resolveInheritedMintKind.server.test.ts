import { describe, expect, it } from "vitest";
import { resolveInheritedMintKind } from "./resolveInheritedMintKind.server";

const NEW_PARENT = `run_${"a".repeat(24) + "01"}`; // run-ops id-shape -> NEW
const LEGACY_PARENT = `run_${"b".repeat(25)}`; // cuid id-shape -> LEGACY

describe("resolveInheritedMintKind (pure id-shape, shared across all mint paths)", () => {
  it("inherits a run-ops (NEW) parent by id-shape -> 'runOpsId' kind", () => {
    expect(resolveInheritedMintKind(NEW_PARENT)).toBe("runOpsId");
  });

  it("inherits a cuid (LEGACY) parent by id-shape -> cuid", () => {
    expect(resolveInheritedMintKind(LEGACY_PARENT)).toBe("cuid");
  });
});
