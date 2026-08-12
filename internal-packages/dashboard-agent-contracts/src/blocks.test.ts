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
import { SIMPLE_EVIDENCE_KINDS } from "./evidence.js";

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
    expect(
      viewBlockInputSchema.safeParse({
        ...legacyChart,
        actions: [{ label: "Runs", intent: { kind: "navigate", target: "/runs?status=FAILED" } }],
      }).success
    ).toBe(true);
  });
});

describe("actions block", () => {
  const watchAction = {
    label: "Set up a watch",
    intent: {
      kind: "watch",
      spec: {
        kind: "error_recurrence",
        fingerprint: "a1b2c3",
        checkEveryMinutes: 15,
        maxHours: 6,
        note: "the TypeError in send-order-receipt",
      },
    },
  };

  const askAction = {
    label: "Investigate it",
    intent: { kind: "ask", prompt: "Investigate the send-order-receipt failures." },
  };

  it("round-trips through both schemas", () => {
    const body = { type: "actions", actions: [watchAction, askAction] };
    const input = viewBlockInputSchema.parse(body);
    expect(input.type === "actions" && input.actions).toHaveLength(2);
    const strict = viewBlockSchema.parse({ ...body, ...envelope });
    expect(strict.type === "actions" && strict.actions[0].intent.kind).toBe("watch");
    expect(parseStoredViewBlock(body).type).toBe("actions");
  });

  it("needs at least one action and caps the row at three", () => {
    expect(viewBlockInputSchema.safeParse({ type: "actions", actions: [] }).success).toBe(false);
    expect(
      viewBlockInputSchema.safeParse({
        type: "actions",
        actions: [askAction, askAction, askAction, askAction],
      }).success
    ).toBe(false);
  });

  it("rejects a propose_fix intent — it is reserved and not executable", () => {
    expect(
      viewBlockInputSchema.safeParse({
        type: "actions",
        actions: [{ label: "Fix it", intent: { kind: "propose_fix", investigationId: "inv_1" } }],
      }).success
    ).toBe(false);
  });

  it("accepts a non-canonical navigate target — the renderer drops it", () => {
    expect(
      viewBlockInputSchema.safeParse({
        type: "actions",
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
        confidence: "high",
        metrics: [{ id: "spend", value: 12, unit: "usd", severity: "ok" }],
      },
    };
    const parsed = reportBlockSchema.parse(evolved);
    expect(parsed.vm.confidence).toBe("high");
    expect(parsed.vm.metrics[0]!.unit).toBe("count");
  });

  it("still rejects a report with no view model", () => {
    expect(reportBlockSchema.safeParse({ ...reportBlock, vm: { title: "health" } }).success).toBe(
      false
    );
    expect(reportBlockSchema.safeParse({ ...reportBlock, vm: null }).success).toBe(false);
  });
});

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
    expect(investigationBlockSchema.parse(JSON.parse(JSON.stringify(strict)))).toEqual(strict);
  });

  it("is in the strict and the lenient unions", () => {
    expect(viewBlockSchema.safeParse(investigationBlock).success).toBe(true);
    const lenient: ViewBlock = investigationBlockSchema.parse(investigationBlock);
    expect(lenient.type).toBe("investigation");
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
    expect(
      viewBlockInputSchema.safeParse({
        type: "investigation",
        investigation: {
          ...concludedInvestigation,
          evidence: [{ kind: "run", uri: "run_abc123", label: "a run" }],
        },
      }).success
    ).toBe(true);
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
    expect(
      investigationBlockSchema.safeParse({ ...investigationBlock, revision: -1 }).success
    ).toBe(false);
  });
});

describe("investigation evidence refs (the model-facing boundary)", () => {
  const withEvidence = (evidence: unknown) =>
    viewBlockInputSchema.safeParse({
      type: "investigation",
      investigation: { ...concludedInvestigation, evidence: [evidence] },
    });

  it("takes a source location as named fields, never as one string", () => {
    expect(
      withEvidence({
        kind: "source",
        path: "src/tasks/send-order-receipt.ts",
        line: 42,
        label: "the retry config",
      }).success
    ).toBe(true);
    expect(withEvidence({ kind: "source", path: "src/a.ts", label: "a file" }).success).toBe(true);
    expect(withEvidence({ kind: "source", uri: "src/a.ts:42", label: "a file" }).success).toBe(
      false
    );
    expect(withEvidence({ kind: "source", path: "", label: "a file" }).success).toBe(false);
    expect(withEvidence({ kind: "source", path: "src/a.ts", line: 0, label: "x" }).success).toBe(
      false
    );
  });

  it("takes a span as its run and span ids", () => {
    expect(
      withEvidence({ kind: "span", runId: "run_abc123", spanId: "span_0f1", label: "the span" })
        .success
    ).toBe(true);
    expect(withEvidence({ kind: "span", uri: "span_0f1", label: "the span" }).success).toBe(false);
  });

  it("still takes one bare id for the simple kinds", () => {
    for (const kind of SIMPLE_EVIDENCE_KINDS) {
      expect(withEvidence({ kind, uri: "abc123", label: "a thing" }).success, kind).toBe(true);
      expect(withEvidence({ kind, label: "a thing" }).success, `${kind} with no uri`).toBe(false);
      expect(withEvidence({ kind, uri: "", label: "a thing" }).success, `${kind} empty`).toBe(
        false
      );
    }
  });

  // The seven simple kinds share one member, so `kind` must still be closed and the
  // two shaped kinds must still be unreachable through it.
  it("refuses a kind outside the catalog, and the shaped kinds' fields as a bare id", () => {
    expect(withEvidence({ kind: "trace", uri: "trace_1", label: "a trace" }).success).toBe(false);
    expect(withEvidence({ kind: "span", uri: "span_1", label: "a span" }).success).toBe(false);
    expect(withEvidence({ kind: "source", uri: "src/a.ts", label: "a file" }).success).toBe(false);
    expect(
      withEvidence({ kind: "run", runId: "run_abc123", spanId: "span_1", label: "x" }).success
    ).toBe(false);
    expect(withEvidence({ uri: "run_abc123", label: "a run" }).success).toBe(false);
  });
});

describe("host-emitted blocks are not model-facing", () => {
  it("refuses a block the model may not produce, and one that is not in the catalog", () => {
    expect(
      viewBlockInputSchema.safeParse({
        type: "watch_result",
        outcome: "watching",
        headline: "Watching the email-sends queue.",
      }).success
    ).toBe(false);
    expect(
      viewBlockInputSchema.safeParse({ type: "report", vm: reportVm, asOf: "x" }).success
    ).toBe(false);
    expect(viewBlockInputSchema.safeParse({ type: "timeline", items: [] }).success).toBe(false);
    // …while the host's own union still takes them.
    expect(
      viewBlockSchema.safeParse({
        type: "watch_result",
        outcome: "watching",
        headline: "Watching the email-sends queue.",
        ...envelope,
      }).success
    ).toBe(true);
  });
});

describe("investigation capabilities", () => {
  const capabilities = {
    version: 1,
    actions: [
      {
        kind: "show_code",
        label: "Show code",
        intent: { kind: "ask", prompt: "Show me src/a.ts around line 42." },
      },
      {
        kind: "view_similar",
        label: "View similar failures",
        intent: { kind: "navigate", target: "trigger://proj_abc/env_abc/error/error_abc" },
      },
    ],
  };

  it("rides on the block, and old cards without it still parse", () => {
    const parsed = investigationBlockSchema.parse({ ...investigationBlock, capabilities });
    expect(parsed.capabilities?.actions).toHaveLength(2);
    expect(investigationBlockSchema.parse(investigationBlock).capabilities).toBeUndefined();
    expect(parseStoredViewBlock(investigationBody)).not.toHaveProperty("capabilities");
  });

  it("is executor-only: the model can't supply it", () => {
    expect(viewBlockInputSchema.parse({ ...investigationBody, capabilities })).not.toHaveProperty(
      "capabilities"
    );
  });

  it("takes only strict intents and a known action kind", () => {
    const withAction = (action: unknown) =>
      investigationBlockSchema.safeParse({
        ...investigationBlock,
        capabilities: { version: 1, actions: [action] },
      });
    expect(
      withAction({
        kind: "view_similar",
        label: "View similar failures",
        intent: { kind: "navigate", target: "error_abc" },
      }).success
    ).toBe(false);
    expect(
      withAction({ kind: "explain_yourself", label: "?", intent: { kind: "ask", prompt: "hi" } })
        .success
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
