import { describe, expect, it } from "vitest";
import { getCapability } from "@internal/alert-contracts";
import { conditionSummary } from "./alertSummaries";
import { limitScopeLabel } from "./limitSummary";

const threshold = (value: number, windowSec: number) =>
  ({ kind: "threshold", operator: ">", value, windowSec }) as const;

describe("conditionSummary", () => {
  it("humanizes threshold units", () => {
    expect(conditionSummary(threshold(30000, 600), "duration_ms")).toBe("> 30s over 10m");
    expect(conditionSummary(threshold(20, 600), "percent")).toBe("> 20% over 10m");
    expect(conditionSummary(threshold(100, 300), "count")).toBe("> 100 over 5m");
    expect(conditionSummary(threshold(5, 300), "rate_per_hour")).toBe("> 5/hr over 5m");
  });
});

describe("limitScopeLabel", () => {
  it("names the picked limits, and says All limits when every one is picked", () => {
    expect(
      limitScopeLabel("limits.all", [
        "limits.api",
        "limits.webhooks.env_rate",
        "limits.webhooks.endpoint_rate",
      ])
    ).toBe("API rate limit, Webhook ingress, Webhook endpoint");
    expect(limitScopeLabel("limits.all")).toBe("All limits");
    expect(limitScopeLabel("limits.all", getCapability("limits.all")!.binding.compositeOf)).toBe(
      "All limits"
    );
    expect(limitScopeLabel("limits.api")).toBe("API rate limit");
    expect(limitScopeLabel("health.all")).toBeUndefined();
  });
});

describe("conditionSummary for limits", () => {
  const state = (stateKey: string, extra: object = {}) =>
    ({ kind: "state", stateKey, ...extra }) as const;

  it("summarises a composite by mode and component count", () => {
    expect(conditionSummary(state("limits.all", { components: ["a", "b", "c", "d"] }))).toBe(
      "Any of 4 limits"
    );
    expect(
      conditionSummary(state("limits.all", { compositeMode: "all", components: ["a", "b"] }))
    ).toBe("All of 2 limits");
    expect(conditionSummary(state("limits.all"))).toBe("Any of 7 limits");
  });

  it("summarises a limit by its signals", () => {
    expect(conditionSummary(state("limits.api", { params: { utilisationPct: 80 } }))).toBe(
      "API rate limit utilisation ≥ 80% or requests denied"
    );
    expect(conditionSummary(state("limits.api", { signals: ["approaching"] }))).toBe(
      "API rate limit utilisation ≥ 80%"
    );
    expect(conditionSummary(state("limits.api", { signals: ["limited"] }))).toBe(
      "API rate limit utilisation: requests denied"
    );
  });

  it("keeps the plain state summary for health.all", () => {
    expect(conditionSummary(state("health.all"))).toBe("State: health.all");
  });

  it("keeps the plain state summary for other state alerts", () => {
    expect(conditionSummary(state("health.flow"))).toBe("State: health.flow");
  });
});
