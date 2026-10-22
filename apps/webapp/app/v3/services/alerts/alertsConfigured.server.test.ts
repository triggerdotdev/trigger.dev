import { describe, expect, it } from "vitest";
import { isAlertsConfigured } from "./alertsConfigured.server";

describe("isAlertsConfigured", () => {
  it("is false when ALERTS_ENABLED is unset, true when set", () => {
    expect(isAlertsConfigured({ alertsEnabled: undefined })).toBe(false);
    expect(isAlertsConfigured({ alertsEnabled: "true" })).toBe(true);
  });
});
