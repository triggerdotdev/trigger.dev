import { describe, expect, it } from "vitest";
import { resolveInheritedMintKind } from "./resolveInheritedMintKind.server";

const NEW_PARENT = `run_${"a".repeat(27)}`; // ksuid id-shape -> NEW
const LEGACY_PARENT = `run_${"b".repeat(25)}`; // cuid id-shape -> LEGACY

describe("resolveInheritedMintKind (pure id-shape, shared across all mint paths)", () => {
  it("inherits a ksuid (NEW) parent by id-shape -> ksuid", () => {
    expect(resolveInheritedMintKind(NEW_PARENT)).toBe("ksuid");
  });

  it("inherits a cuid (LEGACY) parent by id-shape -> cuid", () => {
    expect(resolveInheritedMintKind(LEGACY_PARENT)).toBe("cuid");
  });
});
