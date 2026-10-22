import { describe, expect, it } from "vitest";
import { isV2AlertId, isNewAlertAction } from "./alertIdRouting";

describe("alert delete routing", () => {
  it("recognises a V2 alert id by the alert_ prefix", () => {
    expect(isV2AlertId("alert_abc123")).toBe(true);
    expect(isV2AlertId("clxyz123legacy")).toBe(false);
  });

  it("routes delete of a V2 alert as a new-alert action", () => {
    expect(isNewAlertAction("delete", "alert_abc123")).toBe(true);
  });

  it("routes delete of a legacy channel id as a legacy action", () => {
    expect(isNewAlertAction("delete", "clxyz123legacy")).toBe(false);
  });

  it("routes resolve/stop as new-alert actions regardless of id", () => {
    expect(isNewAlertAction("resolve", "legacy_id")).toBe(true);
    expect(isNewAlertAction("stop", "legacy_id")).toBe(true);
  });

  it("V2 delete matches alertsListEnabled=true, avoiding 404", () => {
    const alertsListEnabled = true;
    expect(isNewAlertAction("delete", "alert_v2id")).toBe(alertsListEnabled);
  });
});
