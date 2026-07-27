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
 * The report/investigation payload schemas themselves are NOT defined here yet
 * (M2 and M5 own them) — only the identity rule is frozen now.
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
// Model-facing input schemas (no envelope)
// ---------------------------------------------------------------------------

/**
 * What the `render_view` tool accepts from the model: bodies only. Identity is
 * assigned by the executor, never by the model.
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

/** Validate here before persisting or emitting a block to a renderer. */
export const viewBlockSchema = z.discriminatedUnion("type", [
  diagnosisBlockSchema,
  chartBlockSchema,
]);

export type EnvelopedDiagnosisBlock = z.infer<typeof diagnosisBlockSchema>;
export type EnvelopedChartBlock = z.infer<typeof chartBlockSchema>;
export type EnvelopedViewBlock = z.infer<typeof viewBlockSchema>;

// ---------------------------------------------------------------------------
// Lenient (read) schemas — envelope optional
// ---------------------------------------------------------------------------

export const legacyDiagnosisBlockSchema = diagnosisBlockBodySchema.extend(optionalEnvelopeShape);
export const legacyChartBlockSchema = chartBlockBodySchema.extend(optionalEnvelopeShape);

/** Parse stored transcript blocks with this: pre-envelope blocks still validate. */
export const legacyViewBlockSchema = z.discriminatedUnion("type", [
  legacyDiagnosisBlockSchema,
  legacyChartBlockSchema,
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
