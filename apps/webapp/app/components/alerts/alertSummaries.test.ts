import { describe, expect, it } from "vitest";
import { conditionSummary } from "./alertSummaries";

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
