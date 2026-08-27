/**
 * Cadence limits are enforced by the schema: run-state watches may poll every
 * minute, aggregate conditions are floored at 5.
 */
import { z } from "zod";

export const runStateCadenceSchema = z.object({
  checkEveryMinutes: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(60)]),
});

export const standardCadenceSchema = z.object({
  checkEveryMinutes: z.union([z.literal(5), z.literal(15), z.literal(60)]),
});

export type RunStateCadence = z.infer<typeof runStateCadenceSchema>;
export type StandardCadence = z.infer<typeof standardCadenceSchema>;

/** Hard ceiling on how long a watch may live. */
export const WATCH_MAX_HOURS = 24;

export const watchCommonSchema = z.object({
  maxHours: z.number().positive().max(WATCH_MAX_HOURS),
  /** Why this watch exists, in the user's terms. Shown when it fires. */
  note: z.string(),
});

export type WatchCommon = z.infer<typeof watchCommonSchema>;

/** Hard ceiling on a queue-depth threshold. */
export const WATCH_MAX_QUEUE_THRESHOLD = 1_000_000;

/** Consecutive no-progress checks `queue_stalled` waits for. Not offered by the card. */
export const WATCH_STALL_TICKS_DEFAULT = 3;
export const WATCH_STALL_TICKS_MIN = 2;
export const WATCH_STALL_TICKS_MAX = 12;

/** Ceiling on the `queue_oldest_age` SLA. */
export const WATCH_MAX_QUEUE_AGE_MINUTES = 24 * 60;

const watchQueueNameSchema = z
  .string()
  .describe(
    "The queue name. A task's own queue is `task/<task id>`; a custom queue is its plain name. If unsure, pass the name as shown — the server resolves it."
  );

/**
 * Kinds taking the same fields share one member with a `kind` enum. They still ask
 * different questions — `run_failed` inverts `run_finished`, `queue_depth_below` is
 * not `backlog_drain` — that difference just isn't in the fields.
 */
export const watchSpecSchema = z.discriminatedUnion("kind", [
  watchCommonSchema
    .extend({
      kind: z.enum(["run_start", "run_finished", "run_failed"]),
      runId: z.string(),
    })
    .merge(runStateCadenceSchema),
  watchCommonSchema
    .extend({ kind: z.literal("backlog_drain"), queue: watchQueueNameSchema })
    .merge(standardCadenceSchema),
  watchCommonSchema
    .extend({
      kind: z.enum(["queue_depth_above", "queue_depth_below"]),
      queue: watchQueueNameSchema,
      threshold: z.number().int().nonnegative().max(WATCH_MAX_QUEUE_THRESHOLD),
    })
    .merge(standardCadenceSchema),
  // The one stateful kind: the streak lives in each check's facts and is handed to
  // the next as `previous`. An `unavailable` tick freezes it rather than resetting.
  watchCommonSchema
    .extend({
      kind: z.literal("queue_stalled"),
      queue: watchQueueNameSchema,
      ticks: z
        .number()
        .int()
        .min(WATCH_STALL_TICKS_MIN)
        .max(WATCH_STALL_TICKS_MAX)
        .default(WATCH_STALL_TICKS_DEFAULT),
    })
    .merge(standardCadenceSchema),
  watchCommonSchema
    .extend({
      kind: z.literal("queue_oldest_age"),
      queue: watchQueueNameSchema,
      thresholdMinutes: z.number().int().positive().max(WATCH_MAX_QUEUE_AGE_MINUTES),
    })
    .merge(standardCadenceSchema),
  // `since` is absent on purpose: it is server-set at persist time, so nothing can
  // backdate the recurrence window.
  watchCommonSchema
    .extend({ kind: z.literal("error_recurrence"), fingerprint: z.string() })
    .merge(standardCadenceSchema),
  watchCommonSchema
    .extend({
      kind: z.literal("health_recovery"),
      report: z.literal("health"),
      fromSeverity: z.enum(["warn", "crit"]),
    })
    .merge(standardCadenceSchema),
]);

/** Splits a grouped member into one type per kind, so `Extract<WatchSpec, { kind }>` still names one shape. */
type PerKind<T> = T extends { kind: infer K extends string }
  ? K extends K
    ? Omit<T, "kind"> & { kind: K }
    : never
  : never;

export type WatchSpec = PerKind<z.infer<typeof watchSpecSchema>>;
export type WatchKind = WatchSpec["kind"];

export const WATCH_KINDS = [
  "run_start",
  "run_finished",
  "run_failed",
  "backlog_drain",
  "queue_depth_above",
  "queue_depth_below",
  "queue_stalled",
  "queue_oldest_age",
  "error_recurrence",
  "health_recovery",
] as const satisfies readonly WatchKind[];

export function isWatchKind(kind: string): kind is WatchKind {
  return (WATCH_KINDS as readonly string[]).includes(kind);
}

/**
 * The transcript id of the record of what a user confirmed on a watch card, keyed
 * by the card's request id. Stable, so a retried submit repairs rather than repeats.
 */
export const WATCH_REQUEST_MESSAGE_ID_PREFIX = "watch-request:";

/** The transcript id of the confirmation that a watch is running, keyed by the watch. */
export const WATCH_CONFIRMATION_MESSAGE_ID_PREFIX = "watch-confirmation:";

/** The transcript id of the note that the user stopped a watch, keyed by the watch. */
export const WATCH_CANCELLED_MESSAGE_ID_PREFIX = "watch-cancelled:";

/**
 * A deterministic consent record, not a turn the user spent, so it never counts
 * against the message cap and the retry button never resends it.
 */
export function isWatchRequestMessageId(id: string | undefined | null): boolean {
  return typeof id === "string" && id.startsWith(WATCH_REQUEST_MESSAGE_ID_PREFIX);
}

/**
 * The dedup key for a watched condition, scoped to one environment. Cadence, note
 * and maxHours are deliberately not part of it.
 */
export function watchIdentity(spec: WatchSpec): string {
  switch (spec.kind) {
    case "run_start":
    case "run_finished":
    case "run_failed":
      return `${spec.kind}:${spec.runId}`;
    case "backlog_drain":
      return `backlog_drain:${spec.queue}`;
    // The threshold is part of the identity.
    case "queue_depth_above":
      return `queue_depth_above:${spec.queue}:${spec.threshold}`;
    case "queue_depth_below":
      return `queue_depth_below:${spec.queue}:${spec.threshold}`;
    // `ticks` is not in the identity: like the cadence, it only tunes sensitivity.
    case "queue_stalled":
      return `queue_stalled:${spec.queue}`;
    // The SLA is part of the identity.
    case "queue_oldest_age":
      return `queue_oldest_age:${spec.queue}:${spec.thresholdMinutes}`;
    case "error_recurrence":
      return `error_recurrence:${spec.fingerprint}`;
    case "health_recovery":
      return `health_recovery:${spec.report}`;
    default: {
      const unreachable: never = spec;
      throw new Error(`Unhandled watch kind: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * `terminal_unsatisfied` means it can never happen now, so stop checking.
 * `unavailable` means the check itself couldn't run: keep the watch alive and retry.
 */
export const watchCheckResults = [
  "pending",
  "satisfied",
  "terminal_unsatisfied",
  "unavailable",
] as const;

export const watchCheckResultSchema = z.enum(watchCheckResults);
export type WatchCheckResult = z.infer<typeof watchCheckResultSchema>;

/**
 * `window_completed` is an answer and gets reported. The resolution alone does not
 * decide what the user sees; see {@link resolveWatchResult}.
 */
export const watchResolutions = [
  "condition_met",
  "window_completed",
  "condition_impossible",
] as const;
export const watchResolutionSchema = z.enum(watchResolutions);
export type WatchResolution = z.infer<typeof watchResolutionSchema>;

/**
 * Wake action ids, delivery ids and banner render keys keep this two-value suffix
 * so persisted wakes and dedup keys stay valid. The resolution travels in the facts.
 */
export function watchResolutionToWireStatus(resolution: WatchResolution): "fired" | "expired" {
  return resolution === "condition_met" ? "fired" : "expired";
}

/**
 * A check landing on the deadline may still resolve `condition_met` or
 * `condition_impossible`. Only `pending`/`unavailable` there become `window_completed`.
 */
export function watchResolutionForCheck(
  result: WatchCheckResult,
  atWindowBoundary: boolean
): WatchResolution | null {
  switch (result) {
    case "satisfied":
      return "condition_met";
    case "terminal_unsatisfied":
      return "condition_impossible";
    case "pending":
    case "unavailable":
      return atWindowBoundary ? "window_completed" : null;
    default: {
      const unreachable: never = result;
      throw new Error(`Unhandled watch check result: ${JSON.stringify(unreachable)}`);
    }
  }
}

export const watchStatuses = ["active", "fired", "expired", "cancelled"] as const;
export const watchStatusSchema = z.enum(watchStatuses);
export type WatchStatus = z.infer<typeof watchStatusSchema>;

/**
 * Whether the user still needs to be told this watch fired. `delivering` is the in-flight
 * claim one deliverer holds, so it is a status the store writes and reads back.
 */
export const watchDeliveryStatuses = [
  "not_required",
  "pending",
  "delivering",
  "delivered",
] as const;
export const watchDeliveryStatusSchema = z.enum(watchDeliveryStatuses);
export type WatchDeliveryStatus = z.infer<typeof watchDeliveryStatusSchema>;

/**
 * `run_finished` resolves `condition_met` on any terminal status, so this set, not
 * the resolution, separates "run finished" from "run failed".
 */
export const WATCH_FAILED_RUN_STATUSES = [
  "COMPLETED_WITH_ERRORS",
  "SYSTEM_FAILURE",
  "CRASHED",
  "EXPIRED",
  "TIMED_OUT",
  "INTERRUPTED",
] as const;

/** Neither a success nor a failure, so its own presentation. */
export const WATCH_CANCELLED_RUN_STATUSES = ["CANCELED"] as const;

export type WatchRunDisposition = "succeeded" | "failed" | "cancelled" | "unknown";

export function watchRunDisposition(status: string | null | undefined): WatchRunDisposition {
  if (!status) return "unknown";
  if (status === "COMPLETED_SUCCESSFULLY") return "succeeded";
  if ((WATCH_FAILED_RUN_STATUSES as readonly string[]).includes(status)) return "failed";
  if ((WATCH_CANCELLED_RUN_STATUSES as readonly string[]).includes(status)) return "cancelled";
  return "unknown";
}

/**
 * Frozen with the facts next to the resolution, so no delivery surface re-reads the
 * source. `verified: false` means the window completed with the source unavailable.
 */
export const watchObservedOutcomeSchema = z.union([
  z.object({
    kind: z.literal("run_start"),
    verified: z.boolean().default(true),
    status: z.string().nullable().default(null),
    started: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("run_finished"),
    verified: z.boolean().default(true),
    /** The observation the presentation splits on. */
    finalStatus: z.string().nullable().default(null),
    durationMs: z.number().nullable().default(null),
  }),
  z.object({
    kind: z.literal("run_failed"),
    verified: z.boolean().default(true),
    /** Null while the run is still going. */
    finalStatus: z.string().nullable().default(null),
    durationMs: z.number().nullable().default(null),
  }),
  z.object({
    kind: z.literal("backlog_drain"),
    verified: z.boolean().default(true),
    /** Null when the depth could not be read. */
    depth: z.number().nullable().default(null),
  }),
  z.object({
    kind: z.literal("queue_depth_above"),
    verified: z.boolean().default(true),
    depth: z.number().nullable().default(null),
    threshold: z.number(),
  }),
  z.object({
    kind: z.literal("queue_depth_below"),
    verified: z.boolean().default(true),
    depth: z.number().nullable().default(null),
    threshold: z.number(),
  }),
  z.object({
    kind: z.literal("queue_stalled"),
    verified: z.boolean().default(true),
    depth: z.number().nullable().default(null),
    /** Consecutive checks that saw no progress, as of this one. */
    notDecreasingStreak: z.number().default(0),
    ticks: z.number(),
  }),
  z.object({
    kind: z.literal("queue_oldest_age"),
    verified: z.boolean().default(true),
    /** Null when nothing was waiting, or it was unreadable. */
    ageMs: z.number().nullable().default(null),
    thresholdMinutes: z.number(),
  }),
  z.object({
    kind: z.literal("error_recurrence"),
    verified: z.boolean().default(true),
    /** Occurrences proven to be after the server-set `since`. */
    countSince: z.number().default(0),
  }),
  z.object({
    kind: z.literal("health_recovery"),
    verified: z.boolean().default(true),
    severity: z.enum(["ok", "warn", "crit"]).nullable().default(null),
  }),
]);

export type WatchObservedOutcome = z.infer<typeof watchObservedOutcomeSchema>;

/**
 * Declared per kind, never inferred: `window_completed` is bad news for a drain
 * watch and good news for an error-recurrence one.
 */
export const watchPresentationCategories = ["positive", "attention", "neutral"] as const;
export const watchPresentationCategorySchema = z.enum(watchPresentationCategories);
export type WatchPresentationCategory = z.infer<typeof watchPresentationCategorySchema>;

export const watchPresentationTones = ["success", "warning", "error", "neutral"] as const;
export const watchPresentationToneSchema = z.enum(watchPresentationTones);
export type WatchPresentationTone = z.infer<typeof watchPresentationToneSchema>;

/** Named by meaning, not glyph. Follows the presentation outcome, not the resolution. */
export const watchSemanticIcons = ["success", "attention", "error", "waiting", "info"] as const;
export const watchSemanticIconSchema = z.enum(watchSemanticIcons);
export type WatchSemanticIcon = z.infer<typeof watchSemanticIconSchema>;

/** The English wording lives in the webapp's `watch-presentation.ts`. */
export const watchHeadlineKeys = [
  // run_start
  "run_started",
  "run_not_started",
  "run_never_starts",
  // run_finished
  "run_finished",
  "run_failed",
  "run_cancelled",
  "run_still_running",
  "run_gone",
  // run_failed
  "run_no_failure",
  "run_succeeded",
  // backlog_drain
  "queue_drained",
  "queue_not_drained",
  "queue_gone",
  // queue_depth_above
  "queue_above_threshold",
  "queue_stayed_below",
  // queue_depth_below
  "queue_back_below",
  "queue_still_above",
  // queue_stalled
  "queue_stalled",
  "queue_kept_moving",
  // queue_oldest_age
  "queue_wait_over_sla",
  "queue_wait_under_sla",
  // error_recurrence
  "error_recurred",
  "error_quiet",
  // health_recovery
  "health_recovered",
  "health_not_recovered",
  "health_unavailable",
  // Any kind, when the window completed without a usable final read.
  "unverified_at_window_end",
] as const;
export const watchHeadlineKeySchema = z.enum(watchHeadlineKeys);
export type WatchHeadlineKey = z.infer<typeof watchHeadlineKeySchema>;

export type WatchResolvedPresentation = {
  category: WatchPresentationCategory;
  tone: WatchPresentationTone;
  semanticIcon: WatchSemanticIcon;
  headlineKey: WatchHeadlineKey;
};

const POSITIVE: Omit<WatchResolvedPresentation, "headlineKey"> = {
  category: "positive",
  tone: "success",
  semanticIcon: "success",
};
const ATTENTION_WARN: Omit<WatchResolvedPresentation, "headlineKey"> = {
  category: "attention",
  tone: "warning",
  semanticIcon: "attention",
};
const ATTENTION_ERROR: Omit<WatchResolvedPresentation, "headlineKey"> = {
  category: "attention",
  tone: "error",
  semanticIcon: "error",
};
const NEUTRAL: Omit<WatchResolvedPresentation, "headlineKey"> = {
  category: "neutral",
  tone: "neutral",
  semanticIcon: "info",
};
const WAITING: Omit<WatchResolvedPresentation, "headlineKey"> = {
  category: "attention",
  tone: "warning",
  semanticIcon: "waiting",
};

/**
 * Total over `kind × resolution` on purpose: adding either fails to compile until
 * every cell is filled. Cells refined by the observed outcome carry the default.
 */
const RESOLVED_RESULTS: Record<WatchKind, Record<WatchResolution, WatchResolvedPresentation>> = {
  run_start: {
    condition_met: { ...POSITIVE, headlineKey: "run_started" },
    window_completed: { ...WAITING, headlineKey: "run_not_started" },
    condition_impossible: { ...NEUTRAL, headlineKey: "run_never_starts" },
  },
  run_finished: {
    // Refined below by the observed final status.
    condition_met: { ...POSITIVE, headlineKey: "run_finished" },
    window_completed: { ...WAITING, headlineKey: "run_still_running" },
    condition_impossible: { ...NEUTRAL, headlineKey: "run_gone" },
  },
  // The inverse question, so the presentation inverts too. `condition_impossible`
  // is refined below into the success headline when a final status proves it.
  run_failed: {
    condition_met: { ...ATTENTION_ERROR, headlineKey: "run_failed" },
    window_completed: { ...POSITIVE, headlineKey: "run_no_failure" },
    condition_impossible: { ...NEUTRAL, headlineKey: "run_gone" },
  },
  backlog_drain: {
    condition_met: { ...POSITIVE, headlineKey: "queue_drained" },
    window_completed: { ...ATTENTION_WARN, headlineKey: "queue_not_drained" },
    condition_impossible: { ...NEUTRAL, headlineKey: "queue_gone" },
  },
  queue_depth_above: {
    condition_met: { ...ATTENTION_WARN, headlineKey: "queue_above_threshold" },
    window_completed: { ...POSITIVE, headlineKey: "queue_stayed_below" },
    condition_impossible: { ...NEUTRAL, headlineKey: "queue_gone" },
  },
  queue_depth_below: {
    condition_met: { ...POSITIVE, headlineKey: "queue_back_below" },
    window_completed: { ...ATTENTION_WARN, headlineKey: "queue_still_above" },
    condition_impossible: { ...NEUTRAL, headlineKey: "queue_gone" },
  },
  queue_stalled: {
    condition_met: { ...ATTENTION_WARN, headlineKey: "queue_stalled" },
    window_completed: { ...POSITIVE, headlineKey: "queue_kept_moving" },
    condition_impossible: { ...NEUTRAL, headlineKey: "queue_gone" },
  },
  queue_oldest_age: {
    condition_met: { ...ATTENTION_WARN, headlineKey: "queue_wait_over_sla" },
    window_completed: { ...POSITIVE, headlineKey: "queue_wait_under_sla" },
    condition_impossible: { ...NEUTRAL, headlineKey: "queue_gone" },
  },
  error_recurrence: {
    condition_met: { ...ATTENTION_ERROR, headlineKey: "error_recurred" },
    window_completed: { ...POSITIVE, headlineKey: "error_quiet" },
    // The fingerprint is gone, so it can't recur under this identity.
    condition_impossible: { ...NEUTRAL, headlineKey: "error_quiet" },
  },
  health_recovery: {
    condition_met: { ...POSITIVE, headlineKey: "health_recovered" },
    window_completed: { ...ATTENTION_WARN, headlineKey: "health_not_recovered" },
    condition_impossible: { ...NEUTRAL, headlineKey: "health_unavailable" },
  },
};

/**
 * The only place a resolved watch becomes something to show. No surface may
 * present from the resolution alone.
 */
export function resolveWatchResult(args: {
  kind: WatchKind;
  resolution: WatchResolution;
  outcome?: WatchObservedOutcome | null;
}): WatchResolvedPresentation {
  const { kind, resolution, outcome } = args;

  // Unconfirmed is not "it didn't happen".
  if (resolution === "window_completed" && outcome && outcome.verified === false) {
    return { ...NEUTRAL, headlineKey: "unverified_at_window_end" };
  }

  // `unknown` keeps the plain "finished" headline: never claim an unobserved failure.
  if (kind === "run_finished" && resolution === "condition_met") {
    const disposition = watchRunDisposition(
      outcome?.kind === "run_finished" ? outcome.finalStatus : null
    );
    if (disposition === "failed") return { ...ATTENTION_ERROR, headlineKey: "run_failed" };
    if (disposition === "cancelled") return { ...NEUTRAL, headlineKey: "run_cancelled" };
  }

  if (kind === "run_failed" && resolution === "condition_impossible") {
    const disposition = watchRunDisposition(
      outcome?.kind === "run_failed" ? outcome.finalStatus : null
    );
    if (disposition === "succeeded") return { ...POSITIVE, headlineKey: "run_succeeded" };
    if (disposition === "cancelled") return { ...NEUTRAL, headlineKey: "run_cancelled" };
  }

  return RESOLVED_RESULTS[kind][resolution];
}

/**
 * What the "investigate attention outcomes" consent covers. Both the agent's wake
 * and the webapp's kick must call this rather than judge for themselves.
 */
export function watchResultNeedsAttention(args: {
  kind: string;
  resolution: WatchResolution;
  outcome?: WatchObservedOutcome | null;
}): boolean {
  if (!isWatchKind(args.kind)) return false;
  const { category } = resolveWatchResult({
    kind: args.kind,
    resolution: args.resolution,
    outcome: args.outcome,
  });
  return category === "attention";
}

/**
 * In-chat delivery is always on and absent here. These two are independent
 * opt-ins, never a radio group.
 */
export const watchFollowUpSchema = z.object({
  /** Open an investigation when the outcome is an attention one. */
  investigateOnAttention: z.boolean().default(false),
  /** Attach an external delivery subscription (email). */
  notifyExternally: z.boolean().default(false),
});

export type WatchFollowUp = z.infer<typeof watchFollowUpSchema>;

/** What the card submits. */
export const watchDraftSchema = z.object({
  spec: watchSpecSchema,
  followUp: watchFollowUpSchema,
  // Set only when the watch targets another project/environment than the one the chat
  // is open in, already resolved (never guessed) by the tool that proposed it.
  target: z.object({ environmentId: z.string() }).optional(),
});

export type WatchDraft = z.infer<typeof watchDraftSchema>;

export const watchExternalNotificationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("enabled") }),
  z.object({ status: z.literal("not_requested") }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);

export type WatchExternalNotification = z.infer<typeof watchExternalNotificationSchema>;
export type WatchExternalNotificationStatus = WatchExternalNotification["status"];

/** The window lengths the card offers, in hours. Capped by {@link WATCH_MAX_HOURS}. */
export const WATCH_WINDOW_HOURS_OPTIONS = [0.5, 1, 2, 6, 12, 24] as const;

/** Lifecycle order: the three questions anyone can ask about one run. */
const RUN_STATE_KINDS = watchSpecSchema.options[0].shape.kind.options;

export function isRunStateWatchKind(kind: WatchKind): boolean {
  return (RUN_STATE_KINDS as readonly string[]).includes(kind);
}

function cadenceOptionsOf(
  schema: typeof runStateCadenceSchema | typeof standardCadenceSchema
): readonly number[] {
  return schema.shape.checkEveryMinutes.options.map((option) => option.value);
}

const RUN_STATE_CADENCE_OPTIONS = cadenceOptionsOf(runStateCadenceSchema);
const STANDARD_CADENCE_OPTIONS = cadenceOptionsOf(standardCadenceSchema);

/** Read off the cadence schemas, so the picker can never offer an option they reject. */
export function watchCadenceOptions(kind: WatchKind): readonly number[] {
  return isRunStateWatchKind(kind) ? RUN_STATE_CADENCE_OPTIONS : STANDARD_CADENCE_OPTIONS;
}

// One family per array, in the order the picker lists them.
const QUEUE_CONDITION_VARIANTS = [
  "backlog_drain",
  "queue_depth_above",
  "queue_depth_below",
  "queue_stalled",
  "queue_oldest_age",
] as const;

export function watchConditionVariants(kind: WatchKind): readonly WatchKind[] {
  if ((RUN_STATE_KINDS as readonly string[]).includes(kind)) return RUN_STATE_KINDS;
  if ((QUEUE_CONDITION_VARIANTS as readonly string[]).includes(kind)) {
    return QUEUE_CONDITION_VARIANTS;
  }
  return [kind];
}

export const WATCH_DEFAULT_QUEUE_THRESHOLD = 100;

/** In minutes. Must match the threshold the queue page tints Oldest wait at. */
export const WATCH_DEFAULT_QUEUE_AGE_MINUTES = 5;
