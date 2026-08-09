import { describe, expect, it } from "vitest";
import { buildReportLayout, type LayoutViewModel } from "./report-layout";
import { reportMessages } from "./report-messages";

const livenessMetric = {
  id: "liveness",
  value: 21 * 60 * 1000,
  unit: "ms" as const,
  severity: "crit" as const,
};

function vmWith(findings: LayoutViewModel["findings"]): LayoutViewModel {
  return {
    title: "health",
    scope: "prod",
    period: "last 60 min",
    windowMinutes: 60,
    summary: { severity: "crit", statements: [] },
    findings,
    metrics: [livenessMetric],
    footer: [],
  };
}

const livenessFinding = {
  type: "liveness",
  severity: "crit" as const,
  reason: "stale",
  metricIds: ["liveness"],
};

describe("buildReportLayout self-evident findings", () => {
  it("drops the metric row of a non-hero finding whose only metric is its own line", () => {
    const layout = buildReportLayout(
      vmWith([
        { type: "execution", severity: "crit", reason: "failures_up", metricIds: [] },
        livenessFinding,
      ]),
      reportMessages("health")
    );

    const liveness = layout.findings.find((f) => f.type === "liveness");
    expect(liveness?.text).toContain("no telemetry in 21m");
    expect(liveness?.expanded).toBe(false);
    expect(liveness?.metrics).toEqual([]);
  });

  it("keeps the metric row when that finding is the hero", () => {
    const layout = buildReportLayout(vmWith([livenessFinding]), reportMessages("health"));

    expect(layout.hero?.type).toBe("liveness");
    expect(layout.hero?.expanded).toBe(true);
    expect(layout.hero?.metrics.map((m) => m.id)).toEqual(["liveness"]);
  });
});
