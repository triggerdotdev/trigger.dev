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
  "error_recurrence",
  "health_recovery",
] as const satisfies readonly WatchKind[];

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

export const watchStatuses = ["active", "fired", "expired", "cancelled"] as const;
export const watchStatusSchema = z.enum(watchStatuses);
export type WatchStatus = z.infer<typeof watchStatusSchema>;

/** Whether the user still needs to be told this watch fired. */
export const watchDeliveryStatuses = ["not_required", "pending", "delivered"] as const;
export const watchDeliveryStatusSchema = z.enum(watchDeliveryStatuses);
export type WatchDeliveryStatus = z.infer<typeof watchDeliveryStatusSchema>;
