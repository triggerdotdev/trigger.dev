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

/**
 * Sweep outcomes whose time series must EXIST from boot, not merely once they first occur.
 *
 * The alert on the sweep asks whether there have been no completed passes in 24 hours, and
 * `sum(increase(...)) == 0` matches nothing at all when the series is absent. That is precisely the
 * case the alert exists for: a sweep that has never run. Seeding the counter at zero makes the
 * absence visible instead of silent.
 *
 * Anything the alerting rules query by outcome belongs here.
 */
export const SNAPSHOT_SWEEP_SEEDED_OUTCOMES = ["completed"] as const;

/** Minimal shape of an OTel counter, so this is testable without a meter. */
type SeedableCounter = { add(value: number, attributes: Record<string, string>): void };

/** Creates the series named in {@link SNAPSHOT_SWEEP_SEEDED_OUTCOMES} at zero. */
export function seedSnapshotSweepOutcomes(counter: SeedableCounter): void {
  for (const outcome of SNAPSHOT_SWEEP_SEEDED_OUTCOMES) {
    counter.add(0, { outcome });
  }
}
