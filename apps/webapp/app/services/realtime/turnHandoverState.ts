import type { SkewProtectionThresholdSignalPayload } from "@trigger.dev/core/v3";
import type { SkewProtectionThresholds } from "~/v3/services/skewProtectionThresholds.server";

// Whether a turn can be handed over mid-turn, and the `trigger.skew-protection-threshold` signal's
// payload. Pure: the sending lives in skewProtectionThresholdSignal.server.ts.

/**
 * Whether a task can continue a handed-over turn, from its `BackgroundWorkerTask.config`: agents on
 * an SDK with handover say `turnHandover: true`. A run on an older SDK would answer the turn again
 * from the first step, so turns are only handed to a deployment whose task says so.
 */
export function taskContinuesTurns(config: unknown): boolean {
  return (config as { turnHandover?: unknown } | null)?.turnHandover === true;
}

/**
 * The version the run continuing a handed-over turn is locked to: the current deployment when its
 * task can continue a turn, otherwise the version of the run handing over (its SDK wrote the
 * handover, so it can continue one). Locking to a version checked here closes the window where a
 * promote to an older SDK lands between the signal and the new run starting.
 */
export function turnContinuationVersion(
  current: { version: string; taskConfig: unknown } | undefined,
  handingOverVersion: string | null | undefined
): string | undefined {
  if (current && taskContinuesTurns(current.taskConfig)) return current.version;
  return handingOverVersion ?? undefined;
}

/**
 * The `trigger.skew-protection-threshold` payload for an environment's thresholds: their versions,
 * and `midTurnTasks`, the current deployment's tasks that can continue a turn and have a threshold
 * (sorted, so a repeat compares equal). No thresholds: the empty payload, whatever the deployment.
 */
export function skewProtectionThresholdSignalPayload(
  thresholds: SkewProtectionThresholds,
  midTurnTasks: string[]
): SkewProtectionThresholdSignalPayload {
  const payload: SkewProtectionThresholdSignalPayload = {};
  if (thresholds.environment) payload.environment = thresholds.environment.version;
  if (thresholds.tasks.size > 0) {
    payload.tasks = Object.fromEntries(
      [...thresholds.tasks].map(([task, threshold]) => [task, threshold.version])
    );
  }
  // Without an environment threshold, only tasks with their own threshold can be moved.
  const moved = payload.environment
    ? midTurnTasks
    : midTurnTasks.filter((task) => thresholds.tasks.has(task));
  if (Object.keys(payload).length > 0 && moved.length > 0) {
    payload.midTurnTasks = [...moved].sort();
  }
  return payload;
}

/** Whether two payloads say the same thing. Anything that isn't a payload reads as empty. */
export function sameSkewProtectionThresholdSignal(a: unknown, b: unknown): boolean {
  const normalize = (value: unknown) => {
    const state = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const tasks = state.tasks && typeof state.tasks === "object" ? state.tasks : {};
    const midTurnTasks = Array.isArray(state.midTurnTasks) ? [...state.midTurnTasks].sort() : [];
    return JSON.stringify([
      state.environment ?? null,
      Object.entries(tasks).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
      midTurnTasks,
    ]);
  };
  return normalize(a) === normalize(b);
}
