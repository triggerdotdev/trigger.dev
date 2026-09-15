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

function vmWithMetric(metric: LayoutViewModel["metrics"][number]): LayoutViewModel {
  return {
    title: "health",
    scope: "prod",
    period: "last 60 min",
    windowMinutes: 60,
    summary: { severity: "warn", statements: [] },
    findings: [{ type: "queue", severity: "warn", reason: "backlog", metricIds: [metric.id] }],
    metrics: [metric],
    footer: [],
  };
}

function heroDelta(metric: LayoutViewModel["metrics"][number]) {
  const layout = buildReportLayout(vmWithMetric(metric), reportMessages("health"));
  return layout.hero?.metrics.find((m) => m.id === metric.id)?.delta;
}

describe("buildReportLayout metric deltas", () => {
  it("renders no delta when a metric collapsed to nothing", () => {
    expect(
      heroDelta({
        id: "pending",
        value: 0,
        unit: "count",
        severity: "warn",
        normal: 40,
        delta: { dir: "down", mult: 0 },
      })
    ).toBeUndefined();
  });

  it("still renders a multiplier for a genuine fall", () => {
    expect(
      heroDelta({
        id: "pending",
        value: 10,
        unit: "count",
        severity: "warn",
        normal: 40,
        delta: { dir: "down", mult: 0 },
      })
    ).toEqual({ text: "↓ 4×", dir: "down" });
  });
});

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
