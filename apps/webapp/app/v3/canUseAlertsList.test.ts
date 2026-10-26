import { describe, expect, it } from "vitest";
import { computeCanUseAlertsList, isAlertsEnabledEnv } from "./canUseAlertsList";

describe("computeCanUseAlertsList", () => {
  it("admin, flag off, configured -> true", () => {
    expect(computeCanUseAlertsList(false, true, true)).toBe(true);
  });

  it("admin, flag off, not configured -> false", () => {
    expect(computeCanUseAlertsList(false, true, false)).toBe(false);
  });

  it("non-admin, flag off -> false", () => {
    expect(computeCanUseAlertsList(false, false, true)).toBe(false);
  });

  it("non-admin, flag on -> true", () => {
    expect(computeCanUseAlertsList(true, false, false)).toBe(true);
  });
});

describe("isAlertsEnabledEnv", () => {
  it("accepts 1 and true", () => {
    expect(isAlertsEnabledEnv("1")).toBe(true);
    expect(isAlertsEnabledEnv("true")).toBe(true);
  });

  it("rejects everything else", () => {
    for (const v of ["0", "false", "", undefined]) expect(isAlertsEnabledEnv(v)).toBe(false);
  });
});
