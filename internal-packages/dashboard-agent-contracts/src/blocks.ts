/**
 * View blocks — the fixed catalog the agent renders UI from, by emitting a spec
 * via the `render_view` tool rather than markup. The webapp maps each block
 * `type` to a React component. Add a block by adding a union member here plus a
 * renderer entry there.
 *
 * Three schema sets, on purpose:
 * - body only (`*BlockBodySchema`, `viewBlockInputSchema`): the model-facing
 *   tool input. Identity is system-owned, so the model never supplies
 *   `id`/`revision`/`version` and the executor stamps the envelope on.
 * - envelope required (`*BlockSchema`, `viewBlockSchema`): emit, persist, revise.
 * - envelope optional (`legacy*BlockSchema`): reading stored transcripts. Blocks
 *   written before the envelope existed have none and must keep parsing forever.
 *   A stored block with no `id` is non-revisable and renders in transcript order.
 */
import { evidenceRefSchema, evidenceSchema } from "./evidence.js";
import { agentIntentSchema } from "./intent.js";
import { runFiltersSchema } from "./run-filters.js";
import { triggerUriSchema } from "./trigger-uri.js";
import { watchSpecSchema } from "./watch.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Identity and revision metadata on every emitted block. Blocks sharing an `id`
 * are one block over time: the renderer keeps the highest `revision`. `version`
 * is the payload schema version, so a renderer can tell an old payload shape
 * from a new one.
 *
 * Frozen id semantics; stored transcripts depend on them. A report block's `id`
 * is its producing tool call and its revision is always 0. An investigation
 * block's `id` is the `investigationId` and its revision climbs — the only
 * progressive block.
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

// The "why did this run fail?" failure card. `type` is the discriminant the
// render registry keys off.
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
 * A chart action's intent. Mirrors `agentIntentSchema`, except the navigate
 * `target` is a plain string here: the model can't always build a canonical URI,
 * and a malformed target must cost one button rather than the whole tool call.
 * The `render_view` executor drops navigate actions that don't parse as a
 * trigger:// URI.
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

// The chart block carries the TRQL query, not the rows: the panel runs it
// through the dashboard's own query execution, so the chart is live and matches
// the Query page. The config mirrors the dashboard's chart builder.
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

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

/**
 * An action's intent. Same lenient navigate `target` as
 * `chartActionIntentSchema`, for the same reason. `propose_fix` is absent on
 * purpose: it is reserved and not executable, so a button can never carry it.
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
    "What the button does. `watch` opens the watch configuration card pre-filled with your spec — the user confirming the card is what starts it. `ask` sends the prompt as the user's next message, phrased in their voice. `navigate` takes them to a page — ONLY with a canonical `trigger://` URI you already hold; an invalid target is silently dropped, so when in doubt use `ask`."
  ),
});

export type ActionsBlockAction = z.infer<typeof actionsBlockActionSchema>;

/** A standalone row of buttons: the agent's offer, clickable. */
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

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

/**
 * The report card's payload: a whole `ReportViewModel` as the reports API
 * returns it. The webapp's `app/presenters/v3/reports/report-view-model.ts` owns
 * the shape and this is the wire contract for it, mirrored by hand because this
 * package is a zod-only leaf and must never import the webapp. Hence the
 * leniency: objects `passthrough()`, arrays default to empty, and only the
 * fields the card renders are named, so a presenter that grows a field still
 * validates and an older stored transcript still renders.
 *
 * Two rules the other blocks don't share: the report is absent from
 * `viewBlockInputSchema` because the host builds it from the `get_report` tool
 * call, and its `revision` is fixed at 0 because every render is a separate
 * historical snapshot that latest-wins must not collapse.
 */
export const reportSeveritySchema = z.enum(["ok", "warn", "crit"]);

/**
 * Formatting hint for a metric value. An unknown unit falls back to `count`
 * rather than failing the block: units are presentation-only and the report side
 * is free to add one.
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
    /** ISO string, set by the presenter. Never read from the renderer's clock. */
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
     * reads `trustworthy` (false means the telemetry is stale, so the numbers are
     * informational only).
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
   * building it needs environment context the producer may not have; a card
   * without one shows no source line.
   */
  reportUri: triggerUriSchema.optional(),
  /** When the snapshot was taken. `vm.generatedAt`, carried up for the header. */
  asOf: z.string(),
});

// ---------------------------------------------------------------------------
// investigation
// ---------------------------------------------------------------------------

/**
 * The investigation card's payload: the state of one investigation, and the
 * card's props.
 *
 * The `investigationId` and `revision` are deliberately absent. Identity lives
 * in the block envelope, stamped by the `render_view` executor after it commits
 * the revision, so the model can neither invent an id nor claim a revision it
 * didn't earn.
 */
export const investigationOutcomeSchema = z.enum(["in_progress", "concluded", "inconclusive"]);

/** The report's severity ladder minus `ok`: an investigation means something was wrong. */
export const investigationSeveritySchema = z.enum(["info", "warn", "crit"]);

/** `testing` is live; the other two are terminal. */
export const hypothesisVerdictSchema = z.enum(["testing", "validated", "invalidated"]);

// Two variants that differ only in their evidence element: strict
// (`evidenceSchema`, canonical URIs, persisted and rendered) and input
// (`evidenceRefSchema`, the bare ids the model writes). Parametrized so they
// can't drift apart.
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
 * code, so every source citation inherits the hedge.
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
      // investigation offers a fix, an inconclusive one offers what to check.
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
 * The ending for a card nobody concluded. There is no "cancelled" or "expired"
 * outcome: a forced settle keeps every established fact and only stops the card
 * claiming work is still happening.
 *
 * It lives here rather than in the agent because both settles use it: the turn's
 * own, and the webapp's between-turns sweep over rows whose turn never came back.
 */
export const UNSETTLED_INVESTIGATION_NOTE =
  "The investigation didn't conclude within this turn, so the cause isn't established. What's below is what was checked.";

export function forceSettledInvestigationState(state: InvestigationState): InvestigationState {
  const { progress: _progress, remediation: _remediation, ...rest } = state;
  return {
    ...rest,
    outcome: "inconclusive",
    // Nothing was settled, so the card can't keep claiming it was.
    confidence: "low",
    headline: `${state.headline.trim()} ${UNSETTLED_INVESTIGATION_NOTE}`.trim(),
  };
}

/**
 * The card's typed next actions, and the one thing on an investigation block the
 * model does not write. Only the executor knows whether a file was really read
 * at the deployed snapshot, so it decides which actions a card offers and grounds
 * each one in a canonical URI. Hence the strict `agentIntentSchema` rather than
 * the chart block's lenient one.
 *
 * `version` is the action vocabulary version, separate from the block's payload
 * version: a host that doesn't know a `kind` skips that action, and a card from
 * before capabilities existed has none, so the field stays optional forever.
 */
export const INVESTIGATION_CAPABILITIES_VERSION = 1;

export const investigationActionKindSchema = z.enum([
  /** Open the cited source location in the conversation. Concluded cards only. */
  "show_code",
  /** Watch for the same failure happening again. */
  "watch_recurrence",
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

// No `capabilities` here on purpose: anything the model sends is stripped at
// this boundary, so it can't fake a button.
const investigationBlockBodyInputSchema = z.object({
  type: z.literal("investigation"),
  investigation: investigationStateInputSchema,
});

// ---------------------------------------------------------------------------
// watch_result
// ---------------------------------------------------------------------------

/**
 * The persisted trace of a submitted watch card. `watching` confirms a running
 * watch; `already_true` and `impossible` mean the immediate check answered the
 * request outright, so no watch exists and there is nothing to cancel.
 *
 * The wording is frozen at append time: the block carries final English rather
 * than a message key, so a later copy change never rewrites what a user was
 * told. Host-emitted only, so it is absent from `viewBlockInputSchema` like
 * `report` and the model can't claim a watch that doesn't exist.
 */
export const watchResultOutcomeSchema = z.enum(["watching", "already_true", "impossible"]);
export type WatchResultOutcome = z.infer<typeof watchResultOutcomeSchema>;

const watchResultBlockBodySchema = z.object({
  type: z.literal("watch_result"),
  outcome: watchResultOutcomeSchema,
  /** The fact, first: "Watching email-sends until the queue drains." */
  headline: z.string(),
  /** The lifetime sentence. Null on a one-shot result — nothing is watching. */
  lifetime: z.string().nullable().default(null),
  /** An aside, e.g. that the creation-time check couldn't run. */
  detail: z.string().nullable().default(null),
  /** The follow-ups that were actually set up, one short line each. */
  followUp: z.array(z.string()).max(4).default([]),
  /** The live watch this confirms, for the chip it pairs with. Null one-shot. */
  watchId: z.string().nullable().default(null),
});

export const watchResultBlockSchema = watchResultBlockBodySchema.merge(blockEnvelopeSchema);
export const legacyWatchResultBlockSchema =
  watchResultBlockBodySchema.extend(optionalEnvelopeShape);

export type EnvelopedWatchResultBlock = z.infer<typeof watchResultBlockSchema>;
export type WatchResultBlock = z.infer<typeof legacyWatchResultBlockSchema>;

// ---------------------------------------------------------------------------
// Model-facing input schemas (no envelope)
// ---------------------------------------------------------------------------

/**
 * What the `render_view` tool accepts from the model: bodies only, with identity
 * assigned by the executor. `report` and `watch_result` are host-emitted and so
 * absent here.
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

// ---------------------------------------------------------------------------
// Strict (emit / persist) schemas — envelope required
// ---------------------------------------------------------------------------

export const diagnosisBlockSchema = diagnosisBlockBodySchema.merge(blockEnvelopeSchema);
export const chartBlockSchema = chartBlockBodySchema.merge(blockEnvelopeSchema);
export const actionsBlockSchema = actionsBlockBodySchema.merge(blockEnvelopeSchema);

/**
 * An investigation at one point in time. `id` is the `investigationId` and
 * `revision` is the one the store committed, so re-emitting the same
 * investigation replaces the card instead of stacking a second one.
 */
export const investigationBlockSchema = investigationBlockBodySchema.merge(blockEnvelopeSchema);

/**
 * A report snapshot. `id` is the `get_report` tool call that produced it and
 * `revision` is pinned to 0 by the type, so nothing can emit a revised report
 * and collapse two snapshots into one card.
 */
export const reportBlockSchema = reportBlockBodySchema
  .merge(blockEnvelopeSchema)
  .extend({ revision: z.literal(0) });

/** Validate here before persisting or emitting a block to a renderer. */
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

// ---------------------------------------------------------------------------
// Lenient (read) schemas — envelope optional
// ---------------------------------------------------------------------------

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
 * The renderer-facing types are the lenient ones, and keep the plain names,
 * because a renderer sees both a freshly emitted enveloped block and a
 * pre-envelope one replayed from a transcript. `EnvelopedViewBlock` is assignable
 * to `ViewBlock`, so a strict producer feeds a lenient consumer without a cast.
 */
export type DiagnosisBlock = z.infer<typeof legacyDiagnosisBlockSchema>;
export type ChartBlock = z.infer<typeof legacyChartBlockSchema>;
export type ActionsBlock = z.infer<typeof legacyActionsBlockSchema>;
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

/** A block with no `id` can't be addressed by a later revision, so it renders once. */
export function isRevisableBlock(block: ViewBlock): boolean {
  return typeof block.id === "string" && block.id.length > 0;
}
