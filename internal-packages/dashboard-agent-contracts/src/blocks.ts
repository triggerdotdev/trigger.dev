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
 *   rather than a stack of near-duplicates.
 *
 * The investigation payload schema is NOT defined here yet (M5 owns it) — only
 * its identity rule is frozen now.
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
]);

export type DiagnosisBlockBody = z.infer<typeof diagnosisBlockBodySchema>;
export type ChartBlockBody = z.infer<typeof chartBlockBodySchema>;
export type ViewBlockInput = z.infer<typeof viewBlockInputSchema>;

// ---------------------------------------------------------------------------
// Strict (emit / persist) schemas — envelope required
// ---------------------------------------------------------------------------

export const diagnosisBlockSchema = diagnosisBlockBodySchema.merge(blockEnvelopeSchema);
export const chartBlockSchema = chartBlockBodySchema.merge(blockEnvelopeSchema);

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
]);

export type EnvelopedDiagnosisBlock = z.infer<typeof diagnosisBlockSchema>;
export type EnvelopedChartBlock = z.infer<typeof chartBlockSchema>;
export type EnvelopedReportBlock = z.infer<typeof reportBlockSchema>;
export type EnvelopedViewBlock = z.infer<typeof viewBlockSchema>;

// ---------------------------------------------------------------------------
// Lenient (read) schemas — envelope optional
// ---------------------------------------------------------------------------

export const legacyDiagnosisBlockSchema = diagnosisBlockBodySchema.extend(optionalEnvelopeShape);
export const legacyChartBlockSchema = chartBlockBodySchema.extend(optionalEnvelopeShape);
export const legacyReportBlockSchema = reportBlockBodySchema.extend(optionalEnvelopeShape);

/** Parse stored transcript blocks with this: pre-envelope blocks still validate. */
export const legacyViewBlockSchema = z.discriminatedUnion("type", [
  legacyDiagnosisBlockSchema,
  legacyChartBlockSchema,
  legacyReportBlockSchema,
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
