import { describe, expect, it } from "vitest";
import { shouldUseV2RunTable } from "~/v3/runTableV2.server";

describe("shouldUseV2RunTable", () => {
  it("defaults to false when the org has no flags", () => {
    expect(shouldUseV2RunTable(null)).toBe(false);
    expect(shouldUseV2RunTable(undefined)).toBe(false);
    expect(shouldUseV2RunTable({})).toBe(false);
  });

  it("returns true only when the flag is the boolean true", () => {
    expect(shouldUseV2RunTable({ runTableV2: true })).toBe(true);
    expect(shouldUseV2RunTable({ runTableV2: false })).toBe(false);
  });

  it("rejects a stringified flag value (strict boolean, no coercion)", () => {
    // A stringified "false" must not coerce to true and cut the org over.
    expect(shouldUseV2RunTable({ runTableV2: "true" })).toBe(false);
    expect(shouldUseV2RunTable({ runTableV2: "false" })).toBe(false);
    expect(shouldUseV2RunTable({ runTableV2: 1 })).toBe(false);
  });

  it("ignores unrelated flags and non-object inputs", () => {
    expect(shouldUseV2RunTable({ mollifierEnabled: true })).toBe(false);
    expect(shouldUseV2RunTable("runTableV2")).toBe(false);
    expect(shouldUseV2RunTable(42)).toBe(false);
  });
});
