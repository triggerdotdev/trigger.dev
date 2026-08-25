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
