/**
 * Contract coverage, not a snapshot: every block the schema union allows must find a
 * renderer in `ViewBlocks`. The block types are read off `viewBlockSchema`, so adding a
 * union member without a `case` fails here instead of rendering an empty div in the panel.
 */
import { viewBlockSchema, type EnvelopedViewBlock } from "@internal/dashboard-agent-contracts";
import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { ViewBlocks } from "./view-catalog";

const envelope = (id: string, revision = 0) => ({ id, revision, version: 1 });

// Typed by the union's discriminant: a new block type stops typechecking until it has one.
const FIXTURES: Record<EnvelopedViewBlock["type"], EnvelopedViewBlock> = {
  diagnosis: {
    ...envelope("diagnosis-1"),
    type: "diagnosis",
    runId: "run_abc123",
    summary: "The run failed on its last retry.",
    category: "user_code_error",
    likelyCause: "A null order id reaches the receipt builder.",
    confidence: "high",
    evidence: [{ type: "error", detail: "TypeError: cannot read id of null" }],
    nextSteps: ["Guard the receipt builder against a missing order."],
  },
  chart: {
    ...envelope("chart-1"),
    type: "chart",
    query: "SELECT toStartOfHour(created_at) AS bucket, count() AS runs FROM runs",
    chartType: "line",
    xAxisColumn: "bucket",
    yAxisColumns: ["runs"],
  },
  actions: {
    ...envelope("actions-1"),
    type: "actions",
    actions: [{ label: "See its failed runs", intent: { kind: "ask", prompt: "Show them" } }],
  },
  report: {
    ...envelope("report-1"),
    type: "report",
    revision: 0,
    asOf: "2026-01-01T00:00:00.000Z",
    vm: {
      title: "health",
      scope: "environment",
      period: "24h",
      generatedAt: "2026-01-01T00:00:00.000Z",
      windowMinutes: 1440,
      summary: { severity: "ok", statements: [] },
      findings: [],
      metrics: [],
      facts: {},
      links: [],
      footer: [],
    },
  },
  watch_result: {
    ...envelope("watch:watch_1"),
    type: "watch_result",
    outcome: "watching",
    headline: "Watching send-order-receipt for failures.",
    lifetime: "24h",
    detail: null,
    followUp: [],
    watchId: "watch_1",
  },
  investigation: {
    ...envelope("investigation-1"),
    type: "investigation",
    investigation: {
      outcome: "concluded",
      severity: "crit",
      confidence: "high",
      title: "send-order-receipt fails on every retry",
      headline: "Every attempt dies on a null order id.",
      remediation: "Guard the receipt builder against a missing order.",
      hypotheses: [],
      evidence: [],
    },
  },
};

const blockTypes = viewBlockSchema.options.map((option) => option.shape.type.value);

function renderedChildren(blocks: EnvelopedViewBlock[]) {
  const tree = ViewBlocks({ blocks, onIntent: () => {} });
  expect(isValidElement(tree)).toBe(true);
  const children = (tree as { props: { children: unknown } }).props.children;
  return Array.isArray(children) ? children : [children];
}

describe("ViewBlocks covers the block contract", () => {
  it("knows every type the schema union allows", () => {
    expect(new Set(blockTypes)).toEqual(new Set(Object.keys(FIXTURES)));
  });

  it.each(blockTypes)("returns a renderer for a %s block", (type) => {
    const fixture = FIXTURES[type as EnvelopedViewBlock["type"]];
    expect(fixture, `no fixture for the ${type} block`).toBeDefined();
    // Parsing first proves the fixture is a block the producer could really emit.
    const block = viewBlockSchema.parse(fixture) as EnvelopedViewBlock;

    const [rendered] = renderedChildren([block]);
    expect(rendered, `ViewBlocks renders nothing for a ${type} block`).not.toBeNull();
    expect(isValidElement(rendered)).toBe(true);
  });

  it("renders every block type together, in order", () => {
    const blocks = blockTypes.map((type) =>
      viewBlockSchema.parse(FIXTURES[type as EnvelopedViewBlock["type"]])
    ) as EnvelopedViewBlock[];
    const rendered = renderedChildren(blocks);
    expect(rendered).toHaveLength(blockTypes.length);
    expect(rendered.every((node) => isValidElement(node))).toBe(true);
  });
});
