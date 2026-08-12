import { describe, expect, it } from "vitest";
import {
  REPORT_TOOL_PART_TYPE,
  isReportToolPart,
  reportBlockFromToolPart,
  reportIsTrustworthy,
} from "./report-block-adapter";
import { blockIdentity, latestRevisionBlocks } from "./view-blocks";

const vm = {
  title: "health",
  scope: "prod",
  period: "last 1h",
  baselineLabel: "vs your 7d normal",
  generatedAt: "2026-07-27T10:15:00.000Z",
  windowMinutes: 60,
  summary: { severity: "crit", statements: [{ findingType: "flow", severity: "crit" }] },
  findings: [
    {
      type: "flow",
      severity: "crit",
      reason: "env_limit_saturation",
      metricIds: ["pending"],
      recommendation: { code: "raise_env_limit" },
    },
  ],
  metrics: [{ id: "pending", value: 4812, unit: "count", severity: "crit" }],
  facts: { trustworthy: true },
  links: [],
  footer: [{ code: "raise_env_limit" }],
};

const uri = "trigger://proj_abc/env_abc/report/health";

function part(overrides: Record<string, unknown> = {}) {
  return {
    type: REPORT_TOOL_PART_TYPE,
    state: "output-available",
    toolCallId: "call_1",
    input: { report: "health" },
    output: vm,
    ...overrides,
  };
}

describe("reportBlockFromToolPart", () => {
  it("builds an immutable snapshot keyed by the tool call", () => {
    const block = reportBlockFromToolPart(part())!;
    expect(block.type).toBe("report");
    expect(block.id).toBe("call_1");
    expect(block.revision).toBe(0);
    expect(block.asOf).toBe(vm.generatedAt);
    expect(block.vm).toEqual(vm);
    expect(block.reportUri).toBeUndefined();
  });

  it("carries a trigger:// source uri when the tool returned one", () => {
    expect(reportBlockFromToolPart(part({ output: { vm, uri } }))!.reportUri).toBe(uri);
    expect(reportBlockFromToolPart(part({ output: { ...vm, reportUri: uri } }))!.reportUri).toBe(
      uri
    );
  });

  it("drops a uri that isn't a valid trigger:// URI, keeping the card", () => {
    const block = reportBlockFromToolPart(
      part({ output: { vm, uri: "https://cloud.trigger.dev/report" } })
    )!;
    expect(block.reportUri).toBeUndefined();
    expect(block.vm.title).toBe("health");
  });

  it("accepts a JSON-string output", () => {
    expect(reportBlockFromToolPart(part({ output: JSON.stringify(vm) }))!.vm).toEqual(vm);
  });

  it("returns null for anything that isn't a completed get_report part", () => {
    expect(reportBlockFromToolPart(part({ type: "tool-run_query" }))).toBeNull();
    expect(reportBlockFromToolPart(part({ state: "input-available" }))).toBeNull();
    expect(reportBlockFromToolPart(part({ state: "output-error" }))).toBeNull();
    expect(reportBlockFromToolPart(part({ toolCallId: undefined }))).toBeNull();
    expect(reportBlockFromToolPart(undefined)).toBeNull();
    expect(reportBlockFromToolPart(null)).toBeNull();
  });

  it("returns null on malformed output instead of throwing", () => {
    expect(reportBlockFromToolPart(part({ output: undefined }))).toBeNull();
    expect(reportBlockFromToolPart(part({ output: "not json at all" }))).toBeNull();
    expect(reportBlockFromToolPart(part({ output: [vm] }))).toBeNull();
    expect(reportBlockFromToolPart(part({ output: { error: "Unknown report" } }))).toBeNull();
    expect(reportBlockFromToolPart(part({ output: { title: "health" } }))).toBeNull();
    expect(reportBlockFromToolPart(part({ output: { ...vm, generatedAt: undefined } }))).toBeNull();
  });

  it("passes the tool output's series and links through", () => {
    const series = { points: [80, 40, 120], kind: "measured" };
    const links = [{ key: "queues", label: "Queues", url: "/queues" }];
    const block = reportBlockFromToolPart(
      part({ output: { ...vm, metrics: [{ ...vm.metrics[0], series }], links } })
    )!;
    expect(block.vm.metrics[0]!.series).toEqual(series);
    expect(block.vm.links).toEqual(links);
    expect(block.vm.summary.severity).toBe("crit");
  });

  it("survives presenter fields it has never seen", () => {
    const block = reportBlockFromToolPart(
      part({ output: { ...vm, confidence: "high", newSection: { a: 1 } } })
    )!;
    expect((block.vm as Record<string, unknown>).confidence).toBe("high");
  });

  it("renders an untrustworthy (stale telemetry) report, flagged", () => {
    const stale = { ...vm, facts: { trustworthy: false, flowSource: "runs" } };
    const block = reportBlockFromToolPart(part({ output: stale }))!;
    expect(block.vm.facts.trustworthy).toBe(false);
    expect(reportIsTrustworthy(block.vm)).toBe(false);
    expect(reportIsTrustworthy({ facts: {} })).toBe(true);
    expect(reportIsTrustworthy(reportBlockFromToolPart(part())!.vm)).toBe(true);
  });

  it("never collapses two reports: different tool calls, different blocks", () => {
    const first = reportBlockFromToolPart(part({ toolCallId: "call_1" }))!;
    const second = reportBlockFromToolPart(
      part({ toolCallId: "call_2", output: { ...vm, generatedAt: "2026-07-27T11:15:00.000Z" } })
    )!;
    expect(blockIdentity(first)).not.toBe(blockIdentity(second));
    expect(latestRevisionBlocks([first, second])).toHaveLength(2);
    const sameKeyAgain = reportBlockFromToolPart(part({ toolCallId: "call_3" }))!;
    expect(latestRevisionBlocks([first, second, sameKeyAgain])).toHaveLength(3);
  });
});

describe("isReportToolPart", () => {
  it("matches a get_report part in any state", () => {
    expect(isReportToolPart(part({ state: "input-streaming" }))).toBe(true);
    expect(isReportToolPart(part({ type: "tool-render_view" }))).toBe(false);
    expect(isReportToolPart(null)).toBe(false);
  });
});
