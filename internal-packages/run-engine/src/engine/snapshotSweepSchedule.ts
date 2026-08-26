/**
 * `undefined` never schedules the job. An empty schedule falls back to the default rather than
 * through: an empty string is falsy, so `setupCron` would filter the job out with nothing logged.
 */
export function resolveSnapshotSweepCron(opts: {
  hasRunner: boolean;
  schedule?: string;
  fallback: string;
}): string | undefined {
  if (!opts.hasRunner) {
    return undefined;
  }
  return opts.schedule?.trim() ? opts.schedule : opts.fallback;
}

/** Default budget for one sweep pass, when the caller supplies none. */
export const DEFAULT_SNAPSHOT_SWEEP_BUDGET_MS = 10_800_000;

/**
 * Keeps the delivery window strictly above the runner's lock TTL, which is the budget plus an hour.
 * Two hours of headroom, so a pass that overruns its budget still holds a lock that outlives the
 * delivery it belongs to.
 */
export function snapshotSweepVisibilityTimeoutMs(budgetMs?: number): number {
  return (budgetMs ?? DEFAULT_SNAPSHOT_SWEEP_BUDGET_MS) + 2 * 60 * 60 * 1000;
}
