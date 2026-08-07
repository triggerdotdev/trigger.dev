/**
 * Three schema sets per block: body only (model input), envelope required
 * (emit/persist), envelope optional (`legacy*`, which must keep parsing forever).
 */
import { evidenceRefSchema, evidenceSchema } from "./evidence.js";
import { agentIntentSchema } from "./intent.js";
import { runFiltersSchema } from "./run-filters.js";
import { triggerUriSchema } from "./trigger-uri.js";
import { watchSpecSchema } from "./watch.js";
import { z } from "zod";

/**
 * Blocks sharing an `id` are one block over time; the renderer keeps the highest
 * `revision`. Id semantics are frozen: stored transcripts depend on them.
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

export const VIEW_BLOCK_VERSION = 1;

// `type` is the discriminant the webapp's render registry keys off.
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

/**
 * Mirrors `agentIntentSchema` but with a lenient string navigate `target`. The
 * `render_view` executor drops navigate actions that don't parse as a trigger:// URI.
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
    "What the button does. `ask` is the default and always works: phrase the user's own follow-up in their voice, and the click sends it as their next message. `navigate` takes them to the matching page — ONLY with a canonical `trigger://` URI you already hold; an invalid target is silently dropped, so when in doubt use `ask`."
  ),
});

export type ChartAction = z.infer<typeof chartActionSchema>;

// Carries the TRQL query, not the rows: the panel runs it through the dashboard's
// own query execution.
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
  /** Optional forever: charts stored before `actions` existed must keep parsing. */
  actions: z
    .array(chartActionSchema)
    .max(3)
    .optional()
    .describe(
      "Optional buttons under the chart, at most 2-3. After a ranking or failures chart, give the top item an 'Investigate <name>' ask action, and a navigate action to the page that shows it (its filtered runs list, its error, its queue) when you have the target."
    ),
});

/**
 * Same lenient navigate `target` as `chartActionIntentSchema`. `propose_fix` is
 * absent on purpose: it is reserved, so a button can never carry it.
 */
const actionIntentSchema = z.union([
  z.object({
    kind: z.literal("ask"),
    prompt: z.string().min(1),
  }),
  z.object({
    kind: z.literal("navigate"),
    target: z.string().min(1),
    filters: runFiltersSchema.optional(),
  }),
  z.object({
    kind: z.literal("watch"),
    spec: watchSpecSchema,
  }),
]);

export const actionsBlockActionSchema = z.object({
  label: z.string().min(1).describe("The button text, e.g. 'Set up a watch'."),
  intent: actionIntentSchema.describe(
    "What the button does. `watch` opens the watch configuration card pre-filled with your spec — the user confirming it is what starts the watch. `ask` sends the prompt as the user's next message, in their voice. `navigate` takes them to a page — ONLY with a canonical `trigger://` URI you already hold; an invalid target is silently dropped."
  ),
});

export type ActionsBlockAction = z.infer<typeof actionsBlockActionSchema>;

const actionsBlockBodySchema = z.object({
  type: z.literal("actions"),
  actions: z
    .array(actionsBlockActionSchema)
    .min(1)
    .max(3)
    .describe(
      "1-3 buttons, the one to take first. Keep labels short and imperative ('Set up a watch', 'See its failed runs')."
    ),
});

/**
 * Hand-mirrored wire contract for the webapp's `ReportViewModel`, which owns the
 * shape. The leniency below is deliberate: a presenter may grow a field.
 */
export const reportSeveritySchema = z.enum(["ok", "warn", "crit"]);

/** An unknown unit falls back to `count` rather than failing the whole block. */
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

/** `link` is a key into `vm.links`. */
export const reportRecommendationSchema = z
  .object({ code: reasonCodeSchema, link: z.string().optional() })
  .passthrough();

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
    scope: z.string(),
    period: z.string(),
    baselineLabel: z.string().optional(),
    /** ISO, set by the presenter. Never read from the renderer's clock. */
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
    /** Free-form. The card reads only `trustworthy`. */
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
  /** Where this snapshot came from. Optional: the producer may lack env context. */
  reportUri: triggerUriSchema.optional(),
  /** `vm.generatedAt`, carried up for the header. */
  asOf: z.string(),
});

/**
 * `investigationId` and `revision` are absent on purpose: identity lives in the
 * block envelope, stamped by the `render_view` executor after it commits.
 */
export const investigationOutcomeSchema = z.enum(["in_progress", "concluded", "inconclusive"]);

export const investigationSeveritySchema = z.enum(["info", "warn", "crit"]);

/** `testing` is live; the other two are terminal. */
export const hypothesisVerdictSchema = z.enum(["testing", "validated", "invalidated"]);

// Parametrized so the strict (canonical URIs) and input (bare ids) variants can't
// drift apart.
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

/** `dirty_commit`: the source read is the nearest snapshot, not provably the deployed code. */
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
      startedAt: z.string().optional(),
      updatedAt: z.string().optional(),
    })
    .superRefine((investigation, ctx) => {
      // Remediation XOR checkNext, decided by the outcome.
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
/** Model-facing variant: evidence cites bare resource ids. */
export const investigationStateInputSchema = investigationStateSchemaWith(
  investigationHypothesisInputSchema,
  evidenceRefSchema
);

/**
 * Shared by both settle paths: the turn's own, and the webapp's between-turns
 * sweep. There is no "cancelled" or "expired" outcome.
 */
export const UNSETTLED_INVESTIGATION_NOTE =
  "The investigation didn't conclude within this turn, so the cause isn't established. What's below is what was checked.";

export function forceSettledInvestigationState(state: InvestigationState): InvestigationState {
  const { progress: _progress, remediation: _remediation, ...rest } = state;
  return {
    ...rest,
    outcome: "inconclusive",
    confidence: "low",
    headline: `${state.headline.trim()} ${UNSETTLED_INVESTIGATION_NOTE}`.trim(),
  };
}

/**
 * Action vocabulary version, separate from the block payload version. A host that
 * doesn't know a `kind` skips that action.
 */
export const INVESTIGATION_CAPABILITIES_VERSION = 1;

export const investigationActionKindSchema = z.enum([
  "show_code",
  "watch_recurrence",
  "view_similar",
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

// No `capabilities` here on purpose: anything the model sends is stripped at this
// boundary, so it can't fake a button.
const investigationBlockBodyInputSchema = z.object({
  type: z.literal("investigation"),
  investigation: investigationStateInputSchema,
});

/**
 * Host-emitted only, so it is absent from `viewBlockInputSchema`. Wording is
 * frozen at append time: the block carries final English, not a message key.
 */
export const watchResultOutcomeSchema = z.enum(["watching", "already_true", "impossible"]);
export type WatchResultOutcome = z.infer<typeof watchResultOutcomeSchema>;

const watchResultBlockBodySchema = z.object({
  type: z.literal("watch_result"),
  outcome: watchResultOutcomeSchema,
  headline: z.string(),
  /** Null on a one-shot result: nothing is watching. */
  lifetime: z.string().nullable().default(null),
  detail: z.string().nullable().default(null),
  followUp: z.array(z.string()).max(4).default([]),
  /** The live watch this confirms. Null on a one-shot result. */
  watchId: z.string().nullable().default(null),
});

export const watchResultBlockSchema = watchResultBlockBodySchema.merge(blockEnvelopeSchema);
export const legacyWatchResultBlockSchema =
  watchResultBlockBodySchema.extend(optionalEnvelopeShape);

export type EnvelopedWatchResultBlock = z.infer<typeof watchResultBlockSchema>;
export type WatchResultBlock = z.infer<typeof legacyWatchResultBlockSchema>;

/**
 * What `render_view` accepts from the model. `report` and `watch_result` are
 * host-emitted and so absent here.
 */
export const viewBlockInputSchema = z.discriminatedUnion("type", [
  diagnosisBlockBodySchema,
  chartBlockBodySchema,
  actionsBlockBodySchema,
  investigationBlockBodyInputSchema,
]);

export type DiagnosisBlockBody = z.infer<typeof diagnosisBlockBodySchema>;
export type ChartBlockBody = z.infer<typeof chartBlockBodySchema>;
export type ActionsBlockBody = z.infer<typeof actionsBlockBodySchema>;
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

export const diagnosisBlockSchema = diagnosisBlockBodySchema.merge(blockEnvelopeSchema);
export const chartBlockSchema = chartBlockBodySchema.merge(blockEnvelopeSchema);
export const actionsBlockSchema = actionsBlockBodySchema.merge(blockEnvelopeSchema);

/** `id` is the `investigationId`, so re-emitting replaces the card instead of stacking. */
export const investigationBlockSchema = investigationBlockBodySchema.merge(blockEnvelopeSchema);

/**
 * `id` is the producing `get_report` call. `revision` is pinned to 0 so
 * latest-wins can't collapse two snapshots into one card.
 */
export const reportBlockSchema = reportBlockBodySchema
  .merge(blockEnvelopeSchema)
  .extend({ revision: z.literal(0) });

/** Validate with this before persisting or emitting a block. */
export const viewBlockSchema = z.discriminatedUnion("type", [
  diagnosisBlockSchema,
  chartBlockSchema,
  actionsBlockSchema,
  reportBlockSchema,
  investigationBlockSchema,
  watchResultBlockSchema,
]);

export type EnvelopedDiagnosisBlock = z.infer<typeof diagnosisBlockSchema>;
export type EnvelopedChartBlock = z.infer<typeof chartBlockSchema>;
export type EnvelopedActionsBlock = z.infer<typeof actionsBlockSchema>;
export type EnvelopedReportBlock = z.infer<typeof reportBlockSchema>;
export type EnvelopedInvestigationBlock = z.infer<typeof investigationBlockSchema>;
export type EnvelopedViewBlock = z.infer<typeof viewBlockSchema>;

export const legacyDiagnosisBlockSchema = diagnosisBlockBodySchema.extend(optionalEnvelopeShape);
export const legacyChartBlockSchema = chartBlockBodySchema.extend(optionalEnvelopeShape);
export const legacyActionsBlockSchema = actionsBlockBodySchema.extend(optionalEnvelopeShape);
export const legacyReportBlockSchema = reportBlockBodySchema.extend(optionalEnvelopeShape);
export const legacyInvestigationBlockSchema =
  investigationBlockBodySchema.extend(optionalEnvelopeShape);

/** Parse stored transcript blocks with this: pre-envelope blocks still validate. */
export const legacyViewBlockSchema = z.discriminatedUnion("type", [
  legacyDiagnosisBlockSchema,
  legacyChartBlockSchema,
  legacyActionsBlockSchema,
  legacyReportBlockSchema,
  legacyInvestigationBlockSchema,
  legacyWatchResultBlockSchema,
]);

/**
 * The plain names are the lenient types, because a renderer sees both enveloped
 * and pre-envelope blocks. `EnvelopedViewBlock` is assignable to `ViewBlock`.
 */
export type DiagnosisBlock = z.infer<typeof legacyDiagnosisBlockSchema>;
export type ChartBlock = z.infer<typeof legacyChartBlockSchema>;
export type ActionsBlock = z.infer<typeof legacyActionsBlockSchema>;
export type ReportBlock = z.infer<typeof legacyReportBlockSchema>;
export type InvestigationBlock = z.infer<typeof legacyInvestigationBlockSchema>;
export type ViewBlock = z.infer<typeof legacyViewBlockSchema>;

export function parseStoredViewBlock(value: unknown): ViewBlock {
  return legacyViewBlockSchema.parse(value);
}

export function safeParseStoredViewBlock(value: unknown) {
  return legacyViewBlockSchema.safeParse(value);
}

/** A block with no `id` can't be addressed by a later revision. */
export function isRevisableBlock(block: ViewBlock): boolean {
  return typeof block.id === "string" && block.id.length > 0;
}
