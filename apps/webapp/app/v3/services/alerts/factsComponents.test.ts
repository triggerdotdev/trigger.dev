import { describe, expect, it } from "vitest";
import { parseComponentsFromFacts, parseEvaluatorStateComponents } from "./factsComponents";

const api = {
  outcome: "met",
  effectiveParams: { utilisationPct: 80 },
  signals: { limited: { count: 3, met: true } },
};

describe("composite facts components", () => {
  it("keeps limit components next to legacy ones (mutation: legacy keys only)", () => {
    expect(
      parseComponentsFromFacts({
        components: { flow: { outcome: "not_met", effectiveParams: {} }, "limits.api": api },
      })
    ).toEqual({ flow: { outcome: "not_met", effectiveParams: {} }, "limits.api": api });
  });

  it("reads a persisted selection without the legacy three (mutation: require every legacy key)", () => {
    expect(parseEvaluatorStateComponents({ lastComponents: { "limits.api": api } })).toEqual({
      "limits.api": api,
    });
  });
});
