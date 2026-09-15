import { describe, expect, it } from "vitest";
import {
  buildReportLayout,
  type LayoutMetricInput,
  type LayoutViewModel,
  REPORT_GLYPH,
} from "~/presenters/v3/reports/report-layout";
import { reportMessages } from "~/presenters/v3/reports/report-messages";
import { delta } from "~/presenters/v3/reports/report-view-model";

const messages = reportMessages("health");

function viewModel(overrides: Partial<LayoutViewModel> = {}): LayoutViewModel {
  return {
    title: "health",
    scope: "prod",
    period: "last 60m",
    windowMinutes: 60,
    summary: { severity: "warn", statements: [{ findingType: "flow", severity: "warn" }] },
    findings: [{ type: "flow", severity: "warn", reason: "backlog_growing", metricIds: [] }],
    metrics: [],
    footer: [],
    ...overrides,
  };
}

/** Builds the metric the way the presenter does, so the rounded multiplier is the real one. */
function metricRow(metric: Omit<LayoutMetricInput, "delta">) {
  const withDelta: LayoutMetricInput = { ...metric, delta: delta(metric.value, metric.normal) };
  const layout = buildReportLayout(
    viewModel({
      findings: [
        { type: "flow", severity: "warn", reason: "backlog_growing", metricIds: [metric.id] },
      ],
      metrics: [withDelta],
    }),
    messages
  );
  const rows = [...(layout.hero?.metrics ?? []), ...layout.findings.flatMap((f) => f.metrics)];
  const row = rows.find((r) => r.id === metric.id);
  if (!row) throw new Error(`metric row ${metric.id} was not rendered`);
  return row;
}

describe("report layout — a metric's movement against its baseline", () => {
  it("renders a collapse as a down arrow with how far it fell", () => {
    const row = metricRow({
      id: "throughput",
      value: 5,
      normal: 100,
      unit: "perMin",
      severity: "crit",
    });

    expect(row.delta).toEqual({ text: `${REPORT_GLYPH.down} 20×`, dir: "down" });
  });

  it("says nothing about a collapse to zero, which has no multiplier", () => {
    const row = metricRow({
      id: "throughput",
      value: 0,
      normal: 100,
      unit: "perMin",
      severity: "crit",
    });

    expect(row.delta).toBeUndefined();
  });

  it("leaves a dip that doesn't round past 1× reading as flat", () => {
    const row = metricRow({
      id: "throughput",
      value: 95,
      normal: 100,
      unit: "perMin",
      severity: "ok",
    });

    expect(row.delta).toEqual({ text: `${REPORT_GLYPH.flat} flat`, dir: "flat" });
  });

  it("still renders a rise with its multiplier", () => {
    const row = metricRow({
      id: "pending",
      value: 1600,
      normal: 100,
      unit: "count",
      severity: "crit",
    });

    expect(row.delta).toEqual({ text: `${REPORT_GLYPH.up} 16×`, dir: "up" });
  });

  it("still renders an unmoved metric as flat", () => {
    const row = metricRow({
      id: "pending",
      value: 100,
      normal: 100,
      unit: "count",
      severity: "ok",
    });

    expect(row.delta).toEqual({ text: `${REPORT_GLYPH.flat} flat`, dir: "flat" });
  });

  it("says nothing about a metric with no baseline", () => {
    const row = metricRow({ id: "pending", value: 100, unit: "count", severity: "ok" });

    expect(row.delta).toBeUndefined();
  });
});
