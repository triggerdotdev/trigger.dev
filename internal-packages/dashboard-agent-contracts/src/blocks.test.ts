import { describe, expect, it } from "vitest";
import {
  VIEW_BLOCK_VERSION,
  isRevisableBlock,
  legacyViewBlockSchema,
  parseStoredViewBlock,
  reportBlockSchema,
  viewBlockInputSchema,
  viewBlockSchema,
  type EnvelopedReportBlock,
  type EnvelopedViewBlock,
  type ViewBlock,
} from "./blocks.js";

// A diagnosis block exactly as stored before the envelope existed.
const legacyDiagnosis = {
  type: "diagnosis",
  runId: "run_abc123",
  summary: "The task threw a TypeError while reading the order payload.",
  category: "user_code_error",
  likelyCause: "`order.items` is undefined for orders created before the v2 migration.",
  confidence: "high",
  evidence: [
    { type: "error", detail: "TypeError: Cannot read properties of undefined (reading 'items')" },
    {
      type: "source",
      detail: "processOrder.ts sums order.items",
      reference: "src/processOrder.ts:42",
    },
  ],
  impact: "12 runs hit the same error in the last hour.",
  nextSteps: ["Guard against a missing items array", "Backfill the legacy orders"],
  actions: [{ label: "View run", kind: "view_run", target: "run_abc123" }],
};

// A chart block exactly as stored before the envelope existed.
const legacyChart = {
  type: "chart",
  title: "Failures per hour",
  query:
    "SELECT toStartOfHour(created_at) AS bucket, countIf(status = 'FAILED') AS failures FROM runs",
  period: "24h",
  chartType: "line",
  xAxisColumn: "bucket",
  yAxisColumns: ["failures"],
  groupByColumn: null,
  stacked: false,
  aggregation: "sum",
};

const envelope = { id: "toolcall_1", revision: 0, version: VIEW_BLOCK_VERSION };

// A health report exactly as `/api/v1/reports/health?format=json` returns it,
// trimmed to one finding and two metrics.
const reportVm = {
  title: "health",
  scope: "prod",
  period: "last 1h",
  baselineLabel: "vs your 7d normal",
  generatedAt: "2026-07-27T10:15:00.000Z",
  windowMinutes: 60,
  summary: {
    severity: "crit",
    statements: [
      { findingType: "flow", severity: "crit" },
      { findingType: "execution", severity: "ok" },
    ],
  },
  findings: [
    {
      type: "flow",
      severity: "crit",
      reason: "env_limit_saturation",
      read: "saturation_chain",
      metricIds: ["pending", "start_latency_p95"],
      recommendation: { code: "raise_env_limit", link: "concurrency_docs" },
      anomalyWindow: { minutes: 38, touchesEnd: true },
      attribution: { dim: "queue", key: "email-sends", share: 0.71, of: "pending" },
      exclusions: [{ code: "not_your_code", evidence: { failures: 0.006 } }],
      observations: [{ code: "not_workers_platform", evidence: { rate: 820 } }],
    },
  ],
  metrics: [
    {
      id: "pending",
      value: 4812,
      unit: "count",
      normal: 40,
      delta: { dir: "up", mult: 120 },
      series: { points: [60, 900, 4812], kind: "measured" },
      severity: "crit",
    },
    {
      id: "start_latency_p95",
      value: 43000,
      unit: "ms",
      aggregation: "p95",
      severity: "crit",
    },
  ],
  facts: { trustworthy: true, flowSource: "queue" },
  links: [{ key: "concurrency_docs", label: "Concurrency & limits", url: "" }],
  footer: [
    { code: "raise_env_limit", link: "concurrency_docs" },
    { code: "do_nothing_drains", value: 26.7 },
  ],
};

const reportBlock = {
  type: "report",
  ...envelope,
  vm: reportVm,
  reportUri: "trigger://proj_abc/env_abc/report/health",
  asOf: reportVm.generatedAt,
};

describe("legacy (stored) parsing", () => {
  it("parses a pre-envelope diagnosis block", () => {
    const parsed = parseStoredViewBlock(legacyDiagnosis);
    expect(parsed.type).toBe("diagnosis");
    expect(parsed.id).toBeUndefined();
    expect(parsed.revision).toBeUndefined();
    expect(parsed.version).toBeUndefined();
  });

  it("parses a pre-envelope chart block", () => {
    expect(legacyViewBlockSchema.safeParse(legacyChart).success).toBe(true);
  });

  it("parses an enveloped block too", () => {
    const parsed = parseStoredViewBlock({ ...legacyDiagnosis, ...envelope });
    expect(parsed.id).toBe("toolcall_1");
    expect(parsed.revision).toBe(0);
  });

  it("still rejects a block that is not in the catalog", () => {
    expect(legacyViewBlockSchema.safeParse({ type: "table", rows: [] }).success).toBe(false);
  });

  it("still rejects a catalog block with a broken payload", () => {
    expect(
      legacyViewBlockSchema.safeParse({ ...legacyDiagnosis, confidence: "very-high" }).success
    ).toBe(false);
    expect(legacyViewBlockSchema.safeParse({ ...legacyChart, yAxisColumns: [] }).success).toBe(
      false
    );
  });
});

describe("strict (emit) parsing", () => {
  it("requires the envelope", () => {
    expect(viewBlockSchema.safeParse(legacyDiagnosis).success).toBe(false);
    expect(viewBlockSchema.safeParse({ ...legacyDiagnosis, ...envelope }).success).toBe(true);
    expect(viewBlockSchema.safeParse({ ...legacyChart, ...envelope }).success).toBe(true);
  });

  it("rejects a negative revision or a zero version", () => {
    expect(viewBlockSchema.safeParse({ ...legacyChart, ...envelope, revision: -1 }).success).toBe(
      false
    );
    expect(viewBlockSchema.safeParse({ ...legacyChart, ...envelope, version: 0 }).success).toBe(
      false
    );
  });

  it("produces values assignable to the lenient renderer type", () => {
    const strict: EnvelopedViewBlock = viewBlockSchema.parse({ ...legacyDiagnosis, ...envelope });
    const lenient: ViewBlock = strict;
    expect(lenient.id).toBe("toolcall_1");
  });
});

describe("model-facing input schema", () => {
  it("accepts a body with no envelope", () => {
    expect(viewBlockInputSchema.safeParse(legacyDiagnosis).success).toBe(true);
  });

  it("strips an envelope the model tried to supply", () => {
    const parsed = viewBlockInputSchema.parse({ ...legacyChart, ...envelope });
    expect(parsed).not.toHaveProperty("id");
    expect(parsed).not.toHaveProperty("revision");
  });
});

describe("report block", () => {
  it("round-trips a whole view model", () => {
    const parsed = reportBlockSchema.parse(reportBlock);
    expect(parsed.vm).toEqual(reportVm);
    expect(parsed.asOf).toBe("2026-07-27T10:15:00.000Z");
    expect(parsed.reportUri).toBe("trigger://proj_abc/env_abc/report/health");
    // And it survives a JSON round-trip, which is how it reaches a transcript.
    expect(reportBlockSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("is part of both the strict and the lenient union", () => {
    expect(viewBlockSchema.safeParse(reportBlock).success).toBe(true);
    const lenient = parseStoredViewBlock(reportBlock);
    expect(lenient.type).toBe("report");
  });

  it("is never model-facing — the agent cannot emit one", () => {
    expect(
      viewBlockInputSchema.safeParse({ type: "report", vm: reportVm, asOf: "x" }).success
    ).toBe(false);
  });

  it("pins revision to 0, so a report can never be revised", () => {
    expect(reportBlockSchema.safeParse({ ...reportBlock, revision: 1 }).success).toBe(false);
    const strict: EnvelopedReportBlock = reportBlockSchema.parse(reportBlock);
    expect(strict.revision).toBe(0);
  });

  it("keeps two snapshots distinct: different ids, so latest-wins can't collapse them", () => {
    const first = reportBlockSchema.parse({ ...reportBlock, id: "toolcall_1" });
    const second = reportBlockSchema.parse({ ...reportBlock, id: "toolcall_2" });
    // Identity is (type, id) — same type, different tool call, so two cards.
    expect(first.id).not.toBe(second.id);
    expect(first.revision).toBe(second.revision);
  });

  it("rejects a bad uri but tolerates none at all", () => {
    expect(
      reportBlockSchema.safeParse({ ...reportBlock, reportUri: "https://example.com/report" })
        .success
    ).toBe(false);
    expect(reportBlockSchema.safeParse({ ...reportBlock, reportUri: undefined }).success).toBe(
      true
    );
  });

  it("is lenient about presenter evolution", () => {
    const evolved = {
      ...reportBlock,
      vm: {
        ...reportVm,
        // A field the presenter grew after this transcript was written.
        confidence: "high",
        metrics: [{ id: "spend", value: 12, unit: "usd", severity: "ok" }],
      },
    };
    const parsed = reportBlockSchema.parse(evolved);
    expect(parsed.vm.confidence).toBe("high");
    // An unknown unit degrades to `count` instead of failing the whole block.
    expect(parsed.vm.metrics[0]!.unit).toBe("count");
  });

  it("still rejects a report with no view model", () => {
    expect(reportBlockSchema.safeParse({ ...reportBlock, vm: { title: "health" } }).success).toBe(
      false
    );
    expect(reportBlockSchema.safeParse({ ...reportBlock, vm: null }).success).toBe(false);
  });
});

describe("isRevisableBlock", () => {
  it("is false without an id", () => {
    expect(isRevisableBlock(parseStoredViewBlock(legacyDiagnosis))).toBe(false);
  });

  it("is true with an id", () => {
    expect(isRevisableBlock(parseStoredViewBlock({ ...legacyChart, ...envelope }))).toBe(true);
  });
});
