/**
 * View blocks — our small "generative UI" catalog. The agent renders rich,
 * on-brand UI by emitting a *spec* (a stack of blocks drawn from this fixed
 * catalog) via the `render_view` tool instead of inventing markup. The webapp has
 * a render registry mapping each block `type` to a React component (see
 * components/dashboard-agent/view-catalog.tsx). That gives us json-render's safety
 * (catalog blocks only, validated, no arbitrary HTML) without its zod 4 / React 19
 * dependency — we stay on the pinned zod 3.
 *
 * Add a block by adding a member to the unions below and a renderer entry in the
 * webapp registry.
 *
 * ## Three schema sets, on purpose
 *
 * | Schema | Envelope | Used by |
 * | --- | --- | --- |
 * | `*BlockBodySchema` / `viewBlockInputSchema` | absent | the `render_view` tool's inputSchema (model-facing) |
 * | `*BlockSchema` / `viewBlockSchema` | required | emitting, persisting, revising |
 * | `legacy*BlockSchema` / `legacyViewBlockSchema` | optional | reading anything already stored |
 *
 * **Lenient on parse, strict on emit.** Identity is system-owned: the model never
 * supplies `id`/`revision`/`version`, so the tool takes the body-only schema and
 * the executor/persistence layer stamps the envelope on. Stored transcripts from
 * before the envelope existed contain blocks with no envelope at all and must keep
 * parsing forever — that's what the lenient set is for. A stored block with no
 * `id` is a **non-revisable** block: it can never be replaced by a later revision
 * and is rendered in transcript order.
 */
import { evidenceRefSchema, evidenceSchema } from "./evidence.js";
import { agentIntentSchema } from "./intent.js";
import { runFiltersSchema } from "./run-filters.js";
import { triggerUriSchema } from "./trigger-uri.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Identity and revision metadata attached to every emitted block.
 *
 * - `id` — stable within a conversation. Two blocks with the same `id` are the
 *   same block at different points in time; the renderer keeps the highest
 *   `revision` and drops the rest.
 * - `revision` — starts at 0 and only increases.
 * - `version` — the block *payload* schema version, so a renderer can tell an
 *   old-shaped payload from a new one. Starts at 1.
 *
 * Frozen id semantics (do not change; stored transcripts depend on them):
 * - A **report** block's `id` is the id of the tool call that produced it and its
 *   `revision` is always 0 — reports are immutable snapshots of a moment.
 * - An **investigation** block's `id` is the `investigationId` and its `revision`
 *   increases as the investigation progresses, so the panel shows one live card
 *   rather than a stack of near-duplicates. It is the only progressive block.
 */
export const blockEnvelopeSchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  version: z.number().int().positive(),
});

export type BlockEnvelope = z.infer<typeof blockEnvelopeSchema>;

const optionalEnvelopeShape = {
  id: z.string().optional(),
  revision: z.number().int().nonnegative().optional(),
  version: z.number().int().positive().optional(),
};

/** Current payload version for the blocks in this file. */
export const VIEW_BLOCK_VERSION = 1;

// ---------------------------------------------------------------------------
// diagnosis
// ---------------------------------------------------------------------------

// The "why did this run fail?" failure card. The agent gathers evidence with the
// read tools, then fills these fields. `type` is the discriminant the render
// registry keys off.
export const diagnosisBlockBodySchema = z.object({
  type: z.literal("diagnosis"),
  runId: z.string().describe("The run this diagnoses, e.g. run_abc123."),
  summary: z.string().describe("One or two plain-language sentences: what happened and why."),
  category: z
    .enum([
      "user_code_error",
      "configuration",
      "dependency",
      "timeout",
      "out_of_memory",
      "rate_limit",
      "external_service",
      "infrastructure",
      "cancellation",
      "unknown",
    ])
    .describe("Your classification of the root cause."),
  likelyCause: z
    .string()
    .describe(
      "The most probable root cause, in specific terms — name the code, config, or dependency."
    ),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe("How confident you are in this diagnosis given the evidence. Be honest."),
  evidence: z
    .array(
      z.object({
        type: z.enum([
          "error",
          "failed_span",
          "child_run",
          "logs",
          "deploy",
          "source",
          "historical_match",
        ]),
        detail: z.string().describe("What this piece of evidence shows."),
        reference: z
          .string()
          .optional()
          .describe(
            "Optional pointer to the evidence: a run id (run_...), error id (error_...), file:line, version, or URL."
          ),
      })
    )
    .describe(
      "The concrete signals behind the diagnosis. Cite real ids, spans, versions, or file:line."
    ),
  impact: z
    .string()
    .optional()
    .describe("Optional: how widespread this is, e.g. how many runs hit the same error recently."),
  nextSteps: z.array(z.string()).describe("Actionable recommendations, most important first."),
  actions: z
    .array(
      z.object({
        label: z.string().describe("Button text, e.g. 'View run' or 'Read the retries docs'."),
        kind: z
          .enum(["view_run", "docs"])
          .describe(
            "view_run links to a run page in this environment; docs opens an external URL."
          ),
        target: z.string().describe("For view_run: a run id (run_...). For docs: an https URL."),
      })
    )
    .optional()
    .describe("Optional call-to-action buttons rendered under the card."),
});

// ---------------------------------------------------------------------------
// chart
// ---------------------------------------------------------------------------

/**
 * A button under a chart. The chart answers "which task failed most"; the
 * actions are what to do about the winner — investigate it, or go look at its
 * runs. The card only *emits* the intent; the host decides whether to honour it,
 * the same rule every other intent follows.
 */
/**
 * A chart action's intent. Mirrors `agentIntentSchema`, but the navigate
 * `target` is a plain string at this boundary — the model can't always build a
 * canonical URI (the grammar embeds ids it doesn't hold), and a malformed
 * target must cost one button, not the whole tool call. The `render_view`
 * executor drops navigate actions whose target isn't a valid trigger:// URI.
 */
const chartActionIntentSchema = z.union([
  z.object({
    kind: z.literal("ask"),
    prompt: z.string().min(1),
  }),
  z.object({
    kind: z.literal("navigate"),
    target: z.string().min(1),
    filters: runFiltersSchema.optional(),
  }),
]);

export const chartActionSchema = z.object({
  label: z
    .string()
    .describe("The button text, naming the thing, e.g. 'Investigate send-order-receipt'."),
  intent: chartActionIntentSchema.describe(
    "What the button does. `ask` is the default and always works: phrase the user's own follow-up in their voice ('Investigate the send-order-receipt failures — why are they failing?'), and the click sends it as their next message. `navigate` takes them to the matching page — ONLY when you already hold a canonical `trigger://` URI for it (e.g. one a tool returned); an invalid target is silently dropped, so when in doubt use `ask`."
  ),
});

export type ChartAction = z.infer<typeof chartActionSchema>;

// The chart block carries the TRQL query (not the rows): the panel runs it
// through the dashboard's own query execution + QueryResultsChart, so the chart
// is live and matches the Query page exactly. The agent describes the chart with
// the SAME config the dashboard's chart builder uses (chartType + axis columns +
// group/aggregation) and writes a query whose result columns map onto it.
export const chartBlockBodySchema = z.object({
  type: z.literal("chart"),
  title: z.string().optional().describe("Optional chart title."),
  query: z
    .string()
    .describe(
      "A read-only TRQL SELECT whose result columns map onto the axes below. The panel runs this query and renders the result, so write it the same way you would for run_query (toStartOfHour/toStartOfDay buckets, countIf/sumIf per series)."
    ),
  period: z
    .string()
    .optional()
    .describe(
      "Time window shorthand like '24h', '7d', '30d' (max 30d), applied to the table's time column."
    ),
  chartType: z
    .enum(["line", "bar"])
    .describe(
      "line for trends over time, bar for comparing categories. Stack with `stacked` for composition."
    ),
  xAxisColumn: z
    .string()
    .describe(
      "The result column for the x-axis: a time bucket (for line) or a category (for bar)."
    ),
  yAxisColumns: z
    .array(z.string())
    .min(1)
    .describe("The numeric result column(s) to plot. One per series, unless groupByColumn is set."),
  groupByColumn: z
    .string()
    .nullish()
    .describe(
      "Optional result column to split a single yAxisColumn into one series per distinct value."
    ),
  stacked: z
    .boolean()
    .optional()
    .describe("Stack the series (cumulative/composition). Default false."),
  aggregation: z
    .enum(["sum", "avg", "count", "min", "max"])
    .optional()
    .describe("How to combine values that share an x point. Default sum."),
  /**
   * Optional and capped at three: a chart that ranks things gets a way to act on
   * the winner. Older stored charts have no `actions` at all and must keep
   * parsing, so this is additive and never required.
   */
  actions: z
    .array(chartActionSchema)
    .max(3)
    .optional()
    .describe(
      "Optional buttons under the chart, at most 2-3. After a ranking or failures chart, give the top item an 'Investigate <name>' ask action, and a navigate action to the page that shows it (its filtered runs list, its error, its queue) when you have the target."
    ),
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

/**
 * The report card's payload: a whole `ReportViewModel` as returned by the
 * reports API (`GET /api/v1/reports/:key?format=json`).
 *
 * **The webapp's `app/presenters/v3/reports/report-view-model.ts` is the source
 * of truth for the shape; the schema below is the WIRE CONTRACT for it.** The
 * two are mirrored by hand on purpose — this package is a zod-only leaf and must
 * never import the webapp — so the schema is deliberately lenient: every object
 * `passthrough()`es unknown keys, arrays default to empty, and only the fields
 * the card actually renders are named. A presenter that grows a field keeps
 * validating here; a stored transcript from an older presenter keeps rendering.
 *
 * Two rules the report block does NOT share with the other blocks:
 *
 * 1. It is **not** in `viewBlockInputSchema`. The model never writes a report —
 *    the host builds the block from the completed `get_report` tool call, so the
 *    card and the model's grounding are the same snapshot and the model cannot
 *    reconstruct (or drift from) a single number.
 * 2. Its `revision` is fixed at `0`. Every render is a separate historical
 *    snapshot keyed by its tool-call id, so latest-wins can never collapse two
 *    report cards into one.
 */
export const reportSeveritySchema = z.enum(["ok", "warn", "crit"]);

/**
 * Formatting hint for a metric value. Unknown units fall back to `count`
 * (`.catch`) rather than failing the block — units are presentation-only and the
 * report side is free to add one.
 */
export const reportUnitSchema = z.enum(["ms", "count", "ratio", "perMin"]).catch("count");

/** A message-catalog code (`report-messages.ts` resolves it to a string). */
const reasonCodeSchema = z.string();

export const reportDeltaSchema = z
  .object({
    dir: z.enum(["up", "down", "flat"]).catch("flat"),
    mult: z.number().optional(),
  })
  .passthrough();

export const reportMetricSchema = z
  .object({
    id: z.string(),
    value: z.number(),
    unit: reportUnitSchema,
    aggregation: z.string().optional(),
    normal: z.number().optional(),
    delta: reportDeltaSchema.optional(),
    series: z
      .object({
        points: z.array(z.number()).default([]),
        kind: z.enum(["measured", "estimated"]).catch("measured"),
      })
      .passthrough()
      .optional(),
    breakdown: z.record(z.number()).optional(),
    annotation: z
      .object({ code: reasonCodeSchema, value: z.number().optional() })
      .passthrough()
      .optional(),
    availability: z.enum(["measured", "unknown"]).optional(),
    severity: reportSeveritySchema,
  })
  .passthrough();

/** A recommendation or hedge: a code plus an optional key into `vm.links`. */
export const reportRecommendationSchema = z
  .object({ code: reasonCodeSchema, link: z.string().optional() })
  .passthrough();

/** A ruled-out cause, or a supporting observation, with its evidence. */
const codeWithEvidenceSchema = z
  .object({ code: reasonCodeSchema, evidence: z.record(z.number()).optional() })
  .passthrough();

export const reportFindingSchema = z
  .object({
    /** Open string, not an enum: "flow" | "execution" | "liveness" | future kinds. */
    type: z.string(),
    severity: reportSeveritySchema,
    reason: reasonCodeSchema,
    read: reasonCodeSchema.optional(),
    metricIds: z.array(z.string()).default([]),
    recommendation: reportRecommendationSchema.optional(),
    hedge: reportRecommendationSchema.optional(),
    anomalyWindow: z
      .object({ minutes: z.number(), touchesEnd: z.boolean() })
      .passthrough()
      .optional(),
    attribution: z
      .object({ dim: z.string(), key: z.string(), share: z.number(), of: z.string() })
      .passthrough()
      .optional(),
    exclusions: z.array(codeWithEvidenceSchema).optional(),
    observations: z.array(codeWithEvidenceSchema).optional(),
  })
  .passthrough();

export const reportSummaryStatementSchema = z
  .object({
    findingType: z.string(),
    severity: reportSeveritySchema,
    reason: reasonCodeSchema.optional(),
  })
  .passthrough();

/** A footer line: an action, or the "do nothing" option (which carries a value). */
export const reportFooterEntrySchema = z
  .object({
    code: reasonCodeSchema,
    link: z.string().optional(),
    value: z.number().optional(),
  })
  .passthrough();

export const reportLinkSchema = z
  .object({ key: z.string(), label: z.string(), url: z.string() })
  .passthrough();

export const reportViewModelSchema = z
  .object({
    /** "health" | "cost" | … — also the key into the message catalog. */
    title: z.string(),
    /** The environment the report is about, e.g. "prod". */
    scope: z.string(),
    /** "last 1h". */
    period: z.string(),
    baselineLabel: z.string().optional(),
    /** ISO string, set by the presenter — never read from the renderer's clock. */
    generatedAt: z.string(),
    windowMinutes: z.number(),
    summary: z
      .object({
        severity: reportSeveritySchema,
        statements: z.array(reportSummaryStatementSchema).default([]),
      })
      .passthrough(),
    findings: z.array(reportFindingSchema).default([]),
    metrics: z.array(reportMetricSchema).default([]),
    /**
     * The dense structured payload for agents. Free-form by design; the card only
     * reads `trustworthy` (false = the telemetry behind the verdict is stale, so
     * the numbers are informational only).
     */
    facts: z.record(z.unknown()).default({}),
    links: z.array(reportLinkSchema).default([]),
    footer: z.array(reportFooterEntrySchema).default([]),
  })
  .passthrough();

export type ReportViewModelPayload = z.infer<typeof reportViewModelSchema>;
export type ReportMetricPayload = z.infer<typeof reportMetricSchema>;
export type ReportFindingPayload = z.infer<typeof reportFindingSchema>;
export type ReportSeverity = z.infer<typeof reportSeveritySchema>;
export type ReportUnit = z.infer<typeof reportUnitSchema>;

const reportBlockBodySchema = z.object({
  type: z.literal("report"),
  vm: reportViewModelSchema,
  /**
   * The `trigger://…/report/{key}` URI this snapshot came from. Optional because
   * it needs the project ref AND the RuntimeEnvironment id, which only a producer
   * with environment context has; a card without one simply shows no source line.
   */
  reportUri: triggerUriSchema.optional(),
  /** When the snapshot was taken — `vm.generatedAt`, carried up for the header. */
  asOf: z.string(),
});

// ---------------------------------------------------------------------------
// investigation
// ---------------------------------------------------------------------------

/**
 * The investigation card's payload — the state of one investigation, as the
 * agent currently understands it.
 *
 * Frozen by the design review of `DemoInvestigationCard` (see the demo card and
 * its fixtures in the webapp): this schema is that card's props, so a reviewed
 * layout and the shipped block can't drift.
 *
 * Two things are deliberately NOT in here: the `investigationId` and the
 * `revision`. Identity is system-owned — it lives in the block envelope, stamped
 * by the `render_view` executor after it commits the revision to the
 * investigations table. The model reports state only, so it can neither invent an
 * id nor claim a revision it didn't earn.
 */
export const investigationOutcomeSchema = z.enum(["in_progress", "concluded", "inconclusive"]);

/** Mirrors the report's severity ladder minus `ok` — an investigation exists because something was wrong. */
export const investigationSeveritySchema = z.enum(["info", "warn", "crit"]);

/** `testing` is live; the other two are terminal. */
export const hypothesisVerdictSchema = z.enum(["testing", "validated", "invalidated"]);

// The hypothesis and state schemas exist in two variants that differ only in
// their evidence element: strict (`evidenceSchema`, canonical trigger:// URIs —
// persisted and rendered) and input (`evidenceRefSchema`, bare resource ids —
// what the model writes; the executor builds the URIs). Parametrized so the two
// can never drift apart.
const investigationHypothesisSchemaWith = <T extends z.ZodTypeAny>(evidence: T) =>
  z
    .object({
      id: z
        .string()
        .describe("A stable id for this hypothesis, so it keeps its place across revisions."),
      statement: z.string().describe("The claim, as one falsifiable sentence."),
      verdict: hypothesisVerdictSchema.describe(
        "Where this hypothesis stands. `testing` while you're still working it."
      ),
      finding: z
        .string()
        .optional()
        .describe("Why the verdict, in one sentence. Required once the verdict is `validated`."),
      evidence: z.array(evidence).default([]).describe("The citations that settled it."),
    })
    .superRefine((hypothesis, ctx) => {
      // A validated hypothesis with no finding is an assertion, not a conclusion.
      if (hypothesis.verdict === "validated" && !hypothesis.finding?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["finding"],
          message: "A validated hypothesis must say what settled it (`finding`).",
        });
      }
    });

export const investigationHypothesisSchema = investigationHypothesisSchemaWith(evidenceSchema);
export const investigationHypothesisInputSchema =
  investigationHypothesisSchemaWith(evidenceRefSchema);

/**
 * A caveat qualifies the whole card. `dirty_commit` is the one v1 case: the
 * source we read is the nearest repository snapshot, not provably the deployed
 * code, so every source citation inherits the hedge. Adding a kind is additive.
 */
export const investigationCaveatSchema = z.object({
  kind: z.literal("dirty_commit"),
  message: z.string(),
});

const investigationStateSchemaWith = <H extends z.ZodTypeAny, E extends z.ZodTypeAny>(
  hypothesis: H,
  evidence: E
) =>
  z
    .object({
      outcome: investigationOutcomeSchema.describe(
        "`in_progress` while testing, `concluded` when there's a cause and a fix, `inconclusive` when the evidence ran out."
      ),
      severity: investigationSeveritySchema.describe("How bad it is."),
      confidence: z
        .enum(["high", "medium", "low"])
        .describe("How much the evidence supports this. Be honest."),
      runId: z.string().optional().describe("The run under investigation, e.g. run_abc123."),
      title: z
        .string()
        .describe("Short headline, e.g. 'send-order-receipt is failing on every retry'."),
      headline: z
        .string()
        .describe(
          "The collapsed view's first paragraph: concluded — severity and cause in a sentence or two; otherwise what you've established so far."
        ),
      remediation: z
        .string()
        .optional()
        .describe(
          "How to fix it. ONLY when the outcome is `concluded` — never alongside checkNext."
        ),
      checkNext: z
        .array(z.string())
        .optional()
        .describe(
          "What the user should check, most useful first. ONLY when the outcome is `inconclusive` — never invent a fix instead."
        ),
      progress: z
        .string()
        .optional()
        .describe(
          "What you're doing right now, e.g. 'Reading the run's spans'. Only while in_progress."
        ),
      hypotheses: z
        .array(hypothesis)
        .default([])
        .describe("The hypotheses you posed, including the ones you ruled out."),
      evidence: z
        .array(evidence)
        .default([])
        .describe("Citations backing the headline itself, beyond the per-hypothesis ones."),
      caveat: investigationCaveatSchema
        .optional()
        .describe("A hedge that qualifies the whole card."),
      /** Optional timestamps for the record. The card doesn't render them. */
      startedAt: z.string().optional(),
      updatedAt: z.string().optional(),
    })
    .superRefine((investigation, ctx) => {
      // Remediation XOR checkNext, decided by the outcome: a concluded
      // investigation offers a fix, an inconclusive one offers what to check, and
      // neither is allowed to borrow the other's ending.
      if (investigation.remediation !== undefined && investigation.outcome !== "concluded") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["remediation"],
          message: "Only a concluded investigation can offer a fix.",
        });
      }
      if (
        investigation.checkNext !== undefined &&
        investigation.checkNext.length > 0 &&
        investigation.outcome !== "inconclusive"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["checkNext"],
          message: "`checkNext` belongs to an inconclusive investigation.",
        });
      }
    });

export const investigationStateSchema = investigationStateSchemaWith(
  investigationHypothesisSchema,
  evidenceSchema
);
/** The model-facing variant: evidence cites bare resource ids (`evidenceRefSchema`). */
export const investigationStateInputSchema = investigationStateSchemaWith(
  investigationHypothesisInputSchema,
  evidenceRefSchema
);

/**
 * The card's typed next actions — and the one thing on an investigation block the
 * model does NOT write.
 *
 * The whole promise of "Show code" is that the code exists, was read, and is
 * pinned: only the executor knows whether a file was actually read this
 * investigation at the deployed snapshot, so it decides which actions a card
 * offers and grounds each one in an already-canonical `trigger://` URI. The model
 * can't ask for a button, and the button can't carry a target it invented — that
 * is why this uses the strict `agentIntentSchema` and not the chart block's
 * lenient `chartActionIntentSchema`.
 *
 * `version` is the action *vocabulary* version, separate from the block's payload
 * version: a host that doesn't know a `kind` skips that action, and a card from
 * before capabilities existed simply has none (the field is optional, forever).
 */
export const INVESTIGATION_CAPABILITIES_VERSION = 1;

export const investigationActionKindSchema = z.enum([
  /** Open the cited source location in the conversation. Concluded cards only. */
  "show_code",
  /** Go look at the other runs that hit this. */
  "view_similar",
  /** Keep asking about this investigation. */
  "ask_follow_up",
]);

export const investigationActionSchema = z.object({
  kind: investigationActionKindSchema,
  label: z.string().min(1),
  intent: agentIntentSchema,
});

export const investigationCapabilitiesSchema = z.object({
  version: z.number().int().positive(),
  actions: z.array(investigationActionSchema).max(4).default([]),
});

const investigationBlockBodySchema = z.object({
  type: z.literal("investigation"),
  investigation: investigationStateSchema,
  /** Executor-populated; absent on every card that predates it. */
  capabilities: investigationCapabilitiesSchema.optional(),
});

// No `capabilities` here on purpose: a field the model can't write is a field the
// model can't fake. Anything it sends is stripped at this boundary.
const investigationBlockBodyInputSchema = z.object({
  type: z.literal("investigation"),
  investigation: investigationStateInputSchema,
});

// ---------------------------------------------------------------------------
// Model-facing input schemas (no envelope)
// ---------------------------------------------------------------------------

/**
 * What the `render_view` tool accepts from the model: bodies only. Identity is
 * assigned by the executor, never by the model.
 *
 * `report` is absent on purpose — see `reportBlockSchema`.
 */
export const viewBlockInputSchema = z.discriminatedUnion("type", [
  diagnosisBlockBodySchema,
  chartBlockBodySchema,
  investigationBlockBodyInputSchema,
]);

export type DiagnosisBlockBody = z.infer<typeof diagnosisBlockBodySchema>;
export type ChartBlockBody = z.infer<typeof chartBlockBodySchema>;
export type InvestigationBlockBody = z.infer<typeof investigationBlockBodySchema>;
export type InvestigationBlockBodyInput = z.infer<typeof investigationBlockBodyInputSchema>;
export type InvestigationState = z.infer<typeof investigationStateSchema>;
export type InvestigationStateInput = z.infer<typeof investigationStateInputSchema>;
export type InvestigationHypothesis = z.infer<typeof investigationHypothesisSchema>;
export type InvestigationOutcome = z.infer<typeof investigationOutcomeSchema>;
export type InvestigationSeverity = z.infer<typeof investigationSeveritySchema>;
export type HypothesisVerdict = z.infer<typeof hypothesisVerdictSchema>;
export type InvestigationCaveat = z.infer<typeof investigationCaveatSchema>;
export type InvestigationAction = z.infer<typeof investigationActionSchema>;
export type InvestigationActionKind = z.infer<typeof investigationActionKindSchema>;
export type InvestigationCapabilities = z.infer<typeof investigationCapabilitiesSchema>;
export type ViewBlockInput = z.infer<typeof viewBlockInputSchema>;

// ---------------------------------------------------------------------------
// Strict (emit / persist) schemas — envelope required
// ---------------------------------------------------------------------------

export const diagnosisBlockSchema = diagnosisBlockBodySchema.merge(blockEnvelopeSchema);
export const chartBlockSchema = chartBlockBodySchema.merge(blockEnvelopeSchema);

/**
 * An investigation at one point in time. `id` is the `investigationId` and
 * `revision` is the revision the store committed — so re-emitting the same
 * investigation with better information replaces the card instead of stacking a
 * second one (latest-wins in `latestRevisionBlocks`).
 */
export const investigationBlockSchema = investigationBlockBodySchema.merge(blockEnvelopeSchema);

/**
 * A report snapshot. `id` is the id of the `get_report` tool call that produced
 * it and `revision` is pinned to `0` by the type — the immutability rule is
 * enforced here rather than left to a comment, so nothing can emit a "revised"
 * report and collapse two snapshots into one card.
 */
export const reportBlockSchema = reportBlockBodySchema
  .merge(blockEnvelopeSchema)
  .extend({ revision: z.literal(0) });

/** Validate here before persisting or emitting a block to a renderer. */
export const viewBlockSchema = z.discriminatedUnion("type", [
  diagnosisBlockSchema,
  chartBlockSchema,
  reportBlockSchema,
  investigationBlockSchema,
]);

export type EnvelopedDiagnosisBlock = z.infer<typeof diagnosisBlockSchema>;
export type EnvelopedChartBlock = z.infer<typeof chartBlockSchema>;
export type EnvelopedReportBlock = z.infer<typeof reportBlockSchema>;
export type EnvelopedInvestigationBlock = z.infer<typeof investigationBlockSchema>;
export type EnvelopedViewBlock = z.infer<typeof viewBlockSchema>;

// ---------------------------------------------------------------------------
// Lenient (read) schemas — envelope optional
// ---------------------------------------------------------------------------

export const legacyDiagnosisBlockSchema = diagnosisBlockBodySchema.extend(optionalEnvelopeShape);
export const legacyChartBlockSchema = chartBlockBodySchema.extend(optionalEnvelopeShape);
export const legacyReportBlockSchema = reportBlockBodySchema.extend(optionalEnvelopeShape);
export const legacyInvestigationBlockSchema =
  investigationBlockBodySchema.extend(optionalEnvelopeShape);

/** Parse stored transcript blocks with this: pre-envelope blocks still validate. */
export const legacyViewBlockSchema = z.discriminatedUnion("type", [
  legacyDiagnosisBlockSchema,
  legacyChartBlockSchema,
  legacyReportBlockSchema,
  legacyInvestigationBlockSchema,
]);

/**
 * The renderer-facing types are the LENIENT ones, and they keep the plain names
 * because a renderer must handle both shapes: a freshly emitted enveloped block
 * and a pre-envelope block replayed from a stored transcript. `EnvelopedViewBlock`
 * is assignable to `ViewBlock`, so a strict producer feeds a lenient consumer
 * without a cast.
 */
export type DiagnosisBlock = z.infer<typeof legacyDiagnosisBlockSchema>;
export type ChartBlock = z.infer<typeof legacyChartBlockSchema>;
export type ReportBlock = z.infer<typeof legacyReportBlockSchema>;
export type InvestigationBlock = z.infer<typeof legacyInvestigationBlockSchema>;
export type ViewBlock = z.infer<typeof legacyViewBlockSchema>;

/** Lenient parse of one stored block. */
export function parseStoredViewBlock(value: unknown): ViewBlock {
  return legacyViewBlockSchema.parse(value);
}

/** Lenient parse of one stored block, zod `safeParse` shape. */
export function safeParseStoredViewBlock(value: unknown) {
  return legacyViewBlockSchema.safeParse(value);
}

/**
 * A block with no `id` can't be addressed by a later revision, so it renders
 * once, in transcript order, and is never replaced.
 */
export function isRevisableBlock(block: ViewBlock): boolean {
  return typeof block.id === "string" && block.id.length > 0;
}
