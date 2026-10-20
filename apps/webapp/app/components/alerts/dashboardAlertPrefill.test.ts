import { describe, expect, it } from "vitest";
import { dashboardAlertPrefill } from "./dashboardAlertPrefill";

describe("dashboardAlertPrefill", () => {
  it("maps overview to the health capability", () => {
    expect(dashboardAlertPrefill("overview")).toEqual({ capability: "health.all", scope: "all" });
  });

  it("maps queues to queue depth", () => {
    expect(dashboardAlertPrefill("queues")).toEqual({ capability: "queue.depth" });
  });

  it("returns undefined for unknown keys", () => {
    expect(dashboardAlertPrefill("llm")).toBeUndefined();
    expect(dashboardAlertPrefill("constructor")).toBeUndefined();
  });
});
