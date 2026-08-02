/**
 * Watches — "tell me when X happens". The agent proposes a WatchSpec, the host
 * persists it and polls the condition on the spec's cadence until it fires,
 * expires, or is cancelled.
 *
 * Cadence limits are enforced in the SCHEMA, not in comments: run-state watches
 * may poll every minute because a run flipping state is cheap to check, while
 * aggregate conditions (backlog, error recurrence, health) are floored at 5
 * minutes so a watch can never turn into a hot loop over analytics data.
 */
import { z } from "zod";

/** Run-state conditions can be checked every minute. */
export const runStateCadenceSchema = z.object({
  checkEveryMinutes: z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(60)]),
});

/** Aggregate conditions are floored at 5 minutes. A 1-minute value fails validation. */
export const standardCadenceSchema = z.object({
  checkEveryMinutes: z.union([z.literal(5), z.literal(15), z.literal(60)]),
});

export type RunStateCadence = z.infer<typeof runStateCadenceSchema>;
export type StandardCadence = z.infer<typeof standardCadenceSchema>;

/** Hard ceiling on how long a watch may live. */
export const WATCH_MAX_HOURS = 24;

export const watchCommonSchema = z.object({
  /** How long to keep checking before expiring, in hours. At most 24. */
  maxHours: z.number().positive().max(WATCH_MAX_HOURS),
  /** Why this watch exists, in the user's terms. Shown when it fires. */
  note: z.string(),
});

export type WatchCommon = z.infer<typeof watchCommonSchema>;

/** Hard ceiling on the `queue_depth_above` threshold — a queue watch is not a query. */
export const WATCH_MAX_QUEUE_THRESHOLD = 1_000_000;

export const watchSpecSchema = z.union([
  watchCommonSchema
    .extend({ kind: z.literal("run_start"), runId: z.string() })
    .merge(runStateCadenceSchema),
  watchCommonSchema
    .extend({ kind: z.literal("run_finished"), runId: z.string() })
    .merge(runStateCadenceSchema),
  watchCommonSchema
    .extend({ kind: z.literal("backlog_drain"), queue: z.string() })
    .merge(standardCadenceSchema),
  // The inverse of `backlog_drain`, on the same depth reader: satisfied when the
  // queue's pending count RISES ABOVE `threshold`. Aggregate, so the 5-minute floor
  // applies — a threshold watch must never become a hot loop over the queue.
  watchCommonSchema
    .extend({
      kind: z.literal("queue_depth_above"),
      queue: z.string(),
      threshold: z.number().int().nonnegative().max(WATCH_MAX_QUEUE_THRESHOLD),
    })
    .merge(standardCadenceSchema),
  // `since` (the timestamp recurrence is measured from) is SERVER-SET when the
  // watch is persisted, so it is deliberately absent here: the model must not be
  // able to backdate a recurrence window.
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

export type WatchSpec = z.infer<typeof watchSpecSchema>;
export type WatchKind = WatchSpec["kind"];

export const WATCH_KINDS = [
  "run_start",
  "run_finished",
  "backlog_drain",
  "queue_depth_above",
  "error_recurrence",
  "health_recovery",
] as const satisfies readonly WatchKind[];

/** Whether a string names a watch kind THIS build knows how to present. */
export function isWatchKind(kind: string): kind is WatchKind {
  return (WATCH_KINDS as readonly string[]).includes(kind);
}

/**
 * The condition a watch is watching, as a stable string, scoped to one
 * environment. Two watches with the same identity in the same environment watch
 * the same thing and should be deduplicated — cadence, note, and maxHours are
 * NOT part of the identity, so re-asking with a different cadence updates the
 * existing watch rather than creating a second one.
 */
export function watchIdentity(spec: WatchSpec): string {
  switch (spec.kind) {
    case "run_start":
    case "run_finished":
      return `${spec.kind}:${spec.runId}`;
    case "backlog_drain":
      return `backlog_drain:${spec.queue}`;
    // The threshold IS part of the identity: "above 500" and "above 5000" are two
    // different questions about the same queue, unlike cadence or note.
    case "queue_depth_above":
      return `queue_depth_above:${spec.queue}:${spec.threshold}`;
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
 * The outcome of one poll:
 * - `pending` — not yet, keep checking.
 * - `satisfied` — the condition happened; fire and notify.
 * - `terminal_unsatisfied` — it can never happen now (e.g. waiting for a run to
 *   start that got cancelled). Stop checking; this is not a failure.
 * - `unavailable` — the check itself couldn't run (data source down, permission
 *   lost). Keep the watch alive and retry.
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
 * How a watch ENDED. Three values, not two: a watch does not "fire or expire", it
 * resolves and reports once.
 *
 * - `condition_met` — the checked condition became true inside the window.
 * - `window_completed` — the window ran out with the condition still not true.
 *   An answer, not silence: "it didn't drain in an hour" is the thing the user
 *   asked to be told.
 * - `condition_impossible` — it can no longer become true (terminal state, the
 *   object is gone).
 *
 * The resolution alone does not decide what the user sees — see
 * {@link resolveWatchResult}. `unavailable` is deliberately NOT here: a check that
 * couldn't run never resolves anything.
 */
export const watchResolutions = [
  "condition_met",
  "window_completed",
  "condition_impossible",
] as const;
export const watchResolutionSchema = z.enum(watchResolutions);
export type WatchResolution = z.infer<typeof watchResolutionSchema>;

/**
 * The WIRE encoding of a resolution (spec §7.5, binding).
 *
 * The resolution model does not rename the on-the-wire identifiers: wake action
 * ids (`wake:watch:{id}:{fired|expired}`), delivery ids (`watch:{id}:{status}`)
 * and banner render keys keep their as-built two-value suffix, so persisted wakes
 * and dedup keys stay valid. The resolution itself travels in the action's FACTS,
 * never in the id.
 */
export function watchResolutionToWireStatus(resolution: WatchResolution): "fired" | "expired" {
  return resolution === "condition_met" ? "fired" : "expired";
}

/**
 * The lifecycle rule that turns a tick into a resolution — the window boundary,
 * §7.4 (binding).
 *
 * A check that lands ON the deadline may still resolve `condition_met` or
 * `condition_impossible`: the final evaluation is a real evaluation, not a
 * formality. Only a `pending` or `unavailable` final result becomes
 * `window_completed`. Before the deadline, `pending` and `unavailable` resolve
 * nothing at all — the watch stays alive and retries.
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

/** Whether the user still needs to be told this watch fired. */
export const watchDeliveryStatuses = ["not_required", "pending", "delivered"] as const;
export const watchDeliveryStatusSchema = z.enum(watchDeliveryStatuses);
export type WatchDeliveryStatus = z.infer<typeof watchDeliveryStatusSchema>;

/* ------------------------------------------------------------------ *
 * Observed outcome — WHAT the resolving check saw
 * ------------------------------------------------------------------ */

/**
 * The run statuses that count as a FAILURE for presentation. `run_finished`
 * resolves `condition_met` on any terminal status, so this set — not the
 * resolution — is what separates "Run abc123 finished" from "Run abc123 failed".
 */
export const WATCH_FAILED_RUN_STATUSES = [
  "COMPLETED_WITH_ERRORS",
  "SYSTEM_FAILURE",
  "CRASHED",
  "EXPIRED",
  "TIMED_OUT",
  "INTERRUPTED",
] as const;

/** Ended on purpose. Neither a success nor a failure — its own presentation. */
export const WATCH_CANCELLED_RUN_STATUSES = ["CANCELED"] as const;

export type WatchRunDisposition = "succeeded" | "failed" | "cancelled" | "unknown";

/** Classify a run's final status for presentation. */
export function watchRunDisposition(status: string | null | undefined): WatchRunDisposition {
  if (!status) return "unknown";
  if (status === "COMPLETED_SUCCESSFULLY") return "succeeded";
  if ((WATCH_FAILED_RUN_STATUSES as readonly string[]).includes(status)) return "failed";
  if ((WATCH_CANCELLED_RUN_STATUSES as readonly string[]).includes(status)) return "cancelled";
  return "unknown";
}

/**
 * What the resolving check OBSERVED, per kind — the second half of a resolved
 * result. Stored on the row next to the resolution and frozen with the facts, so
 * every delivery surface reads one set of observations and none of them re-reads
 * the source to reconstruct what happened (§7.5).
 *
 * `verified` is common to all of them: false when the window completed while the
 * source was unavailable, so the presentation says the condition couldn't be
 * confirmed rather than claiming it didn't happen (§4.2).
 */
export const watchObservedOutcomeSchema = z.union([
  z.object({
    kind: z.literal("run_start"),
    verified: z.boolean().default(true),
    /** The run's status at the resolving check. */
    status: z.string().nullable().default(null),
    started: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("run_finished"),
    verified: z.boolean().default(true),
    /** The run's FINAL status — the observation the presentation splits on. */
    finalStatus: z.string().nullable().default(null),
    durationMs: z.number().nullable().default(null),
  }),
  z.object({
    kind: z.literal("backlog_drain"),
    verified: z.boolean().default(true),
    /** The depth the resolving check read. Null when it could not be read. */
    depth: z.number().nullable().default(null),
  }),
  z.object({
    kind: z.literal("queue_depth_above"),
    verified: z.boolean().default(true),
    depth: z.number().nullable().default(null),
    threshold: z.number(),
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

/* ------------------------------------------------------------------ *
 * The resolved-result mapping — (kind + resolution + observed outcome)
 * ------------------------------------------------------------------ */

/**
 * The presentation classification. Declared per kind, never inferred from a
 * "good news kind" list: `window_completed` is bad news for a drain watch and
 * good news for an "error stayed quiet" one.
 */
export const watchPresentationCategories = ["positive", "attention", "neutral"] as const;
export const watchPresentationCategorySchema = z.enum(watchPresentationCategories);
export type WatchPresentationCategory = z.infer<typeof watchPresentationCategorySchema>;

/** The visual accent. Same four tokens the agent surfaces already speak. */
export const watchPresentationTones = ["success", "warning", "error", "neutral"] as const;
export const watchPresentationToneSchema = z.enum(watchPresentationTones);
export type WatchPresentationTone = z.infer<typeof watchPresentationToneSchema>;

/**
 * The icon, named by MEANING rather than glyph, so a surface with a different
 * icon set still shows the same thing. It follows the presentation outcome, never
 * the bare resolution: a failed run never wears a success check (§4.2, binding).
 */
export const watchSemanticIcons = ["success", "attention", "error", "waiting", "info"] as const;
export const watchSemanticIconSchema = z.enum(watchSemanticIcons);
export type WatchSemanticIcon = z.infer<typeof watchSemanticIconSchema>;

/**
 * WHICH sentence to say. The final English wording is the host's job (the
 * webapp's `watch-presentation.ts`); contracts only fixes the set of things a
 * resolved watch can mean, so a second surface can't invent a seventh meaning.
 */
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
  // backlog_drain
  "queue_drained",
  "queue_not_drained",
  "queue_gone",
  // queue_depth_above
  "queue_above_threshold",
  "queue_stayed_below",
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

/** One resolved result, as every surface consumes it. */
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
 * The exhaustive per-kind mapping, as a TABLE: `kind × resolution` is a total
 * `Record`, so adding a watch kind or a resolution value fails to compile until
 * every cell is filled in. That is the point — the mapping may never fall through
 * to a default that quietly presents a failure as a success.
 *
 * Cells the observed outcome refines (run_finished's final status) carry the
 * DEFAULT here and are overridden in {@link resolveWatchResult}.
 */
const RESOLVED_RESULTS: Record<WatchKind, Record<WatchResolution, WatchResolvedPresentation>> = {
  run_start: {
    condition_met: { ...POSITIVE, headlineKey: "run_started" },
    window_completed: { ...WAITING, headlineKey: "run_not_started" },
    condition_impossible: { ...NEUTRAL, headlineKey: "run_never_starts" },
  },
  run_finished: {
    // Refined by the observed final status below — a completion WITH FAILURE
    // presents as attention, however cleanly it resolved.
    condition_met: { ...POSITIVE, headlineKey: "run_finished" },
    window_completed: { ...WAITING, headlineKey: "run_still_running" },
    condition_impossible: { ...NEUTRAL, headlineKey: "run_gone" },
  },
  backlog_drain: {
    condition_met: { ...POSITIVE, headlineKey: "queue_drained" },
    window_completed: { ...ATTENTION_WARN, headlineKey: "queue_not_drained" },
    condition_impossible: { ...NEUTRAL, headlineKey: "queue_gone" },
  },
  // The inverted comparison inverts the presentation too: crossing the threshold
  // is the bad news here, and the quiet window is the good one.
  queue_depth_above: {
    condition_met: { ...ATTENTION_WARN, headlineKey: "queue_above_threshold" },
    window_completed: { ...POSITIVE, headlineKey: "queue_stayed_below" },
    condition_impossible: { ...NEUTRAL, headlineKey: "queue_gone" },
  },
  error_recurrence: {
    condition_met: { ...ATTENTION_ERROR, headlineKey: "error_recurred" },
    window_completed: { ...POSITIVE, headlineKey: "error_quiet" },
    // The fingerprint is gone from the environment: it cannot come back under
    // this identity, which is the same good news as staying quiet.
    condition_impossible: { ...NEUTRAL, headlineKey: "error_quiet" },
  },
  health_recovery: {
    condition_met: { ...POSITIVE, headlineKey: "health_recovered" },
    window_completed: { ...ATTENTION_WARN, headlineKey: "health_not_recovered" },
    condition_impossible: { ...NEUTRAL, headlineKey: "health_unavailable" },
  },
};

/**
 * The one place a resolved watch becomes something to show — resolution PLUS
 * observed outcome, never the resolution alone.
 *
 * Shape of the argument is (kind, resolution, observed outcome) on purpose: the
 * kind comes from the spec, the resolution from the lifecycle, the outcome from
 * the resolving check — and no surface may substitute its own third input.
 */
export function resolveWatchResult(args: {
  kind: WatchKind;
  resolution: WatchResolution;
  outcome?: WatchObservedOutcome | null;
}): WatchResolvedPresentation {
  const { kind, resolution, outcome } = args;

  // A window that completed without a usable final read is its own answer: the
  // condition could not be CONFIRMED, which is not "it didn't happen".
  if (resolution === "window_completed" && outcome && outcome.verified === false) {
    return { ...NEUTRAL, headlineKey: "unverified_at_window_end" };
  }

  // The one cell the observed outcome decides: a run that finished is not
  // automatically good news. `unknown` keeps the plain "finished" headline —
  // claiming a failure nobody observed is the worse mistake.
  if (kind === "run_finished" && resolution === "condition_met") {
    const disposition = watchRunDisposition(
      outcome?.kind === "run_finished" ? outcome.finalStatus : null
    );
    if (disposition === "failed") return { ...ATTENTION_ERROR, headlineKey: "run_failed" };
    if (disposition === "cancelled") return { ...NEUTRAL, headlineKey: "run_cancelled" };
  }

  return RESOLVED_RESULTS[kind][resolution];
}
