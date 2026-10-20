import { describe, expect, it } from "vitest";
import { computeCanUseAlertsList, isAlertsEnabledEnv } from "./canUseAlertsList";

describe("computeCanUseAlertsList", () => {
  it("admin, flag off -> true", () => {
    expect(computeCanUseAlertsList(false, true)).toBe(true);
  });

  it("non-admin, flag off -> false", () => {
    expect(computeCanUseAlertsList(false, false)).toBe(false);
  });

  it("non-admin, flag on -> true", () => {
    expect(computeCanUseAlertsList(true, false)).toBe(true);
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
