import { describe, expect, it } from "vitest";
import {
  buildReportLayout,
  type LayoutViewModel,
  reportTrust,
} from "~/presenters/v3/reports/report-layout";
import { reportMessages } from "~/presenters/v3/reports/report-messages";

const messages = reportMessages("health");

function viewModel(facts?: Record<string, unknown>): LayoutViewModel {
  return {
    title: "health",
    scope: "prod",
    period: "last 60m",
    windowMinutes: 60,
    summary: { severity: "warn", statements: [{ findingType: "flow", severity: "warn" }] },
    findings: [{ type: "flow", severity: "warn", reason: "backlog_growing", metricIds: [] }],
    metrics: [],
    footer: [],
    ...(facts === undefined ? {} : { facts }),
  };
}

function trustFor(untrustworthyReason?: string) {
  return reportTrust({
    facts: { trustworthy: false, ...(untrustworthyReason ? { untrustworthyReason } : {}) },
  });
}

describe("report layout — why the numbers can't be trusted", () => {
  it("calls stale telemetry stale", () => {
    expect(trustFor("telemetry_stale")?.badge).toBe("stale data");
    expect(trustFor("telemetry_stale")?.note).toContain("stale");
  });

  it("does not call a report with no telemetry stale", () => {
    const trust = trustFor("telemetry_absent");

    expect(trust?.badge).toBe("no telemetry");
    expect(trust?.note).toContain("No telemetry");
    expect(trust?.note).not.toContain("stale");
  });

  it("does not call an unmeasured flow stale", () => {
    const trust = trustFor("flow_unmeasured");

    expect(trust?.badge).toBe("unmeasured");
    expect(trust?.note).not.toContain("stale");
  });

  // A caveat may only discount the input it names. These pin the claim, not the wording.
  it("does not call measured run aggregates a snapshot when only the telemetry feed is missing", () => {
    const note = trustFor("telemetry_absent")!.note;

    // What is actually missing: a feed to date the report by.
    expect(note).toMatch(/current|fresh/i);
    // What is not: the aggregates below, which are measured over the window either way.
    expect(note).not.toMatch(/snapshot|point-in-time|informational only|rather than a measured/i);
  });

  it("names the queue depth as the unmeasured input, not a metric the report measured", () => {
    const note = trustFor("flow_unmeasured")!.note;

    expect(note).toMatch(/queue depth|backlog/i);
    expect(note).not.toMatch(/throughput|start latency|failures|duration/i);
    expect(note).not.toMatch(/informational only/i);
  });

  it("caveat and headline blame the same unmeasured input", () => {
    const note = trustFor("flow_unmeasured")!.note;
    const headline = messages.statementMessage("flow", "crit", "flow_unmeasured");

    const names = (text: string) => ({
      depth: /queue depth/i.test(text),
      throughput: /throughput/i.test(text),
    });
    expect(names(note)).toEqual(names(headline));
  });

  it("gives the three untrustworthy states three different badges", () => {
    const badges = ["telemetry_stale", "telemetry_absent", "flow_unmeasured"].map(
      (reason) => trustFor(reason)?.badge
    );

    expect(new Set(badges).size).toBe(3);
  });

  it("falls back without claiming staleness when the reason is missing", () => {
    expect(trustFor()).toBeDefined();
    expect(trustFor()?.note).not.toContain("stale");
  });

  it("says nothing when the report is trustworthy", () => {
    expect(reportTrust({ facts: { trustworthy: true } })).toBeUndefined();
    expect(reportTrust({})).toBeUndefined();
  });

  it("carries the chosen caveat into the layout", () => {
    const layout = buildReportLayout(
      viewModel({ trustworthy: false, untrustworthyReason: "telemetry_absent" }),
      messages
    );

    expect(layout.trust).toEqual({
      badge: "no telemetry",
      note: expect.stringContaining("No telemetry"),
    });
  });

  it("leaves a trustworthy report with no caveat at all", () => {
    expect(buildReportLayout(viewModel(), messages).trust).toBeUndefined();
  });
});
