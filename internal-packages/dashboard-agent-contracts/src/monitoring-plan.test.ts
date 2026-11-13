import { describe, expect, it } from "vitest";
import { parseMonitoringPlan } from "./monitoring-plan.js";

const curated = {
  id: "p1",
  title: "Failure rate",
  description: "Catches a bad deploy that makes runs fail.",
  draft: {
    area: "runs",
    what: "runs.failure_rate",
    condition: { kind: "threshold", operator: ">", value: 5, windowSec: 600 },
  },
};

const query = {
  id: "p2",
  title: "No checkout runs",
  description: "Tells you if checkout stops running at all.",
  draft: {
    area: "query",
    query: "SELECT count() AS runs FROM runs WHERE task_identifier = 'checkout'",
    querySignalChoice: { mode: "absence" },
  },
};

const plan = (items: unknown[]) => ({ goal: "Watch production after this deploy", items });

describe("parseMonitoringPlan", () => {
  it("accepts a curated item and a query item", () => {
    const parsed = parseMonitoringPlan({ ...plan([curated, query]), horizon: "2h" });
    expect(parsed?.items.map((i) => i.id)).toEqual(["p1", "p2"]);
  });

  // Mutation: dropping .min(1)/.max(6) on items lets these through.
  it("rejects an empty plan and one with 7 items", () => {
    expect(parseMonitoringPlan(plan([]))).toBeUndefined();
    const seven = Array.from({ length: 7 }, (_, i) => ({ ...curated, id: `p${i}` }));
    expect(parseMonitoringPlan(plan(seven))).toBeUndefined();
  });

  // Mutation: dropping the completeness refinement lets these through.
  it("rejects a curated draft without a condition", () => {
    const { condition: _c, ...noCondition } = curated.draft;
    expect(parseMonitoringPlan(plan([{ ...curated, draft: noCondition }]))).toBeUndefined();
    const emptyCondition = { ...curated.draft, condition: {} };
    expect(parseMonitoringPlan(plan([{ ...curated, draft: emptyCondition }]))).toBeUndefined();
  });

  it("rejects a query draft without a signal choice", () => {
    const { querySignalChoice: _s, ...noSignal } = query.draft;
    expect(parseMonitoringPlan(plan([{ ...query, draft: noSignal }]))).toBeUndefined();
  });
});
