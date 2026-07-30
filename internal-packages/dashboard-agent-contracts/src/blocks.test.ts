import { describe, expect, it } from "vitest";
import {
  VIEW_BLOCK_VERSION,
  investigationBlockSchema,
  investigationStateSchema,
  isRevisableBlock,
  legacyViewBlockSchema,
  parseStoredViewBlock,
  reportBlockSchema,
  viewBlockInputSchema,
  viewBlockSchema,
  type EnvelopedInvestigationBlock,
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

describe("chart actions", () => {
  // A ranking chart answers "which task fails most" — the actions are what to do
  // about the winner. Two kinds, both from the intent union.
  const actions = [
    {
      label: "Investigate send-order-receipt",
      intent: {
        kind: "ask",
        prompt: "Investigate the send-order-receipt failures — why are they failing?",
      },
    },
    {
      label: "See its failed runs",
      intent: {
        kind: "navigate",
        target: "trigger://proj_abc/env_abc/runs",
        filters: { tasks: ["send-order-receipt"], period: "1d" },
      },
    },
  ];

  it("parses a chart with actions", () => {
    const parsed = viewBlockInputSchema.parse({ ...legacyChart, actions });
    expect(parsed.type).toBe("chart");
    expect(parsed.type === "chart" && parsed.actions).toHaveLength(2);
    expect(viewBlockSchema.safeParse({ ...legacyChart, ...envelope, actions }).success).toBe(true);
    expect(parseStoredViewBlock({ ...legacyChart, actions }).type).toBe("chart");
  });

  it("still parses a chart with no actions", () => {
    expect(viewBlockInputSchema.safeParse(legacyChart).success).toBe(true);
    expect(legacyViewBlockSchema.safeParse(legacyChart).success).toBe(true);
  });

  it("caps the row at three buttons", () => {
    const fourth = { label: "One too many", intent: { kind: "ask", prompt: "And this?" } };
    expect(
      viewBlockInputSchema.safeParse({ ...legacyChart, actions: [...actions, fourth, fourth] })
        .success
    ).toBe(false);
  });

  it("accepts a non-canonical navigate target — the renderer drops it, the call survives", () => {
    // The model can't always build a canonical URI, and a malformed target must
    // cost one button rather than fail the whole render_view call. ChartActions
    // filters non-parsing targets out at render time.
    expect(
      viewBlockInputSchema.safeParse({
        ...legacyChart,
        actions: [{ label: "Runs", intent: { kind: "navigate", target: "/runs?status=FAILED" } }],
      }).success
    ).toBe(true);
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

// ---------------------------------------------------------------------------
// investigation
// ---------------------------------------------------------------------------

const runEvidence = {
  kind: "run" as const,
  uri: "trigger://proj_abc/env_abc/run/run_abc123",
  label: "run_abc123 · failed after 3 attempts",
  excerpt: "attempt 1 429 · attempt 2 429 · attempt 3 429",
};

const concludedInvestigation = {
  outcome: "concluded",
  severity: "crit",
  confidence: "high",
  runId: "run_abc123",
  title: "send-order-receipt is failing on every retry",
  headline: "The provider is rate limiting this key and all three retries land in the same window.",
  remediation: "Raise minTimeoutInMs to 30s with a factor of 2 and cap the queue at 20.",
  hypotheses: [
    {
      id: "hyp_rate_limit",
      statement: "The email provider is rate limiting this API key.",
      verdict: "validated",
      finding: "All three attempts returned 429 rate_limit_exceeded inside 20 seconds.",
      evidence: [runEvidence],
    },
  ],
  evidence: [runEvidence],
};

const investigationBody = { type: "investigation", investigation: concludedInvestigation };
const investigationBlock = { ...investigationBody, id: "inv_abc123", revision: 2, version: 1 };

describe("investigation block", () => {
  it("round-trips body and envelope", () => {
    expect(viewBlockInputSchema.safeParse(investigationBody).success).toBe(true);

    const strict: EnvelopedInvestigationBlock = investigationBlockSchema.parse(investigationBlock);
    expect(strict.id).toBe("inv_abc123");
    expect(strict.revision).toBe(2);
    expect(strict.investigation.remediation).toBeDefined();
    // And it survives the JSON round-trip that carries it into a transcript.
    expect(investigationBlockSchema.parse(JSON.parse(JSON.stringify(strict)))).toEqual(strict);
  });

  it("is in the strict and the lenient unions", () => {
    expect(viewBlockSchema.safeParse(investigationBlock).success).toBe(true);
    // Enveloped values are assignable to the lenient renderer type.
    const lenient: ViewBlock = investigationBlockSchema.parse(investigationBlock);
    expect(lenient.type).toBe("investigation");
    // A pre-envelope stored block still parses.
    expect(parseStoredViewBlock(investigationBody).id).toBeUndefined();
  });

  it("strips identity the model tried to supply", () => {
    const parsed = viewBlockInputSchema.parse({
      ...investigationBody,
      id: "inv_smuggled",
      revision: 9,
      version: 3,
      investigation: { ...concludedInvestigation, investigationId: "inv_smuggled", revision: 9 },
    }) as { investigation: Record<string, unknown> };
    expect(parsed).not.toHaveProperty("id");
    expect(parsed).not.toHaveProperty("revision");
    expect(parsed.investigation).not.toHaveProperty("investigationId");
    expect(parsed.investigation).not.toHaveProperty("revision");
  });

  it("lets a concluded investigation offer a fix, but never what-to-check-next", () => {
    expect(
      viewBlockInputSchema.safeParse({
        ...investigationBody,
        investigation: { ...concludedInvestigation, checkNext: ["Add a span"] },
      }).success
    ).toBe(false);
  });

  it("lets an inconclusive investigation say what to check, but never a fix", () => {
    const inconclusive = {
      ...concludedInvestigation,
      outcome: "inconclusive",
      remediation: undefined,
      checkNext: ["Add a span around the aggregation step."],
    };
    expect(
      viewBlockInputSchema.safeParse({ type: "investigation", investigation: inconclusive }).success
    ).toBe(true);
    expect(
      viewBlockInputSchema.safeParse({
        type: "investigation",
        investigation: { ...inconclusive, remediation: "Just retry it." },
      }).success
    ).toBe(false);
  });

  it("requires a finding once a hypothesis is validated", () => {
    const withoutFinding = {
      ...concludedInvestigation,
      hypotheses: [{ ...concludedInvestigation.hypotheses[0]!, finding: undefined }],
    };
    expect(
      viewBlockInputSchema.safeParse({ type: "investigation", investigation: withoutFinding })
        .success
    ).toBe(false);
    // A hypothesis still being tested doesn't need one.
    expect(
      viewBlockInputSchema.safeParse({
        type: "investigation",
        investigation: {
          ...concludedInvestigation,
          hypotheses: [
            { id: "hyp_open", statement: "Something else.", verdict: "testing", evidence: [] },
          ],
        },
      }).success
    ).toBe(true);
  });

  it("the model-facing input accepts bare resource ids; the strict schema still demands trigger:// URIs", () => {
    // Input boundary: the model cites by bare id (it can't build the URI — the
    // grammar embeds the environment id); the executor canonicalizes.
    expect(
      viewBlockInputSchema.safeParse({
        type: "investigation",
        investigation: {
          ...concludedInvestigation,
          evidence: [{ kind: "run", uri: "run_abc123", label: "a run" }],
        },
      }).success
    ).toBe(true);
    // Persist/emit boundary: anything that isn't a canonical URI stays rejected.
    expect(
      investigationStateSchema.safeParse({
        ...concludedInvestigation,
        evidence: [{ kind: "run", uri: "run_abc123", label: "a run" }],
      }).success
    ).toBe(false);
  });

  it("is the one progressive block: revisions share an id and climb", () => {
    const rev0 = investigationBlockSchema.parse({ ...investigationBlock, revision: 0 });
    const rev1 = investigationBlockSchema.parse({ ...investigationBlock, revision: 1 });
    expect(rev0.id).toBe(rev1.id);
    expect(rev1.revision).toBeGreaterThan(rev0.revision);
    // Unlike a report, whose revision is pinned to 0.
    expect(
      investigationBlockSchema.safeParse({ ...investigationBlock, revision: -1 }).success
    ).toBe(false);
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
