// React-free live tail helpers.

// How far back each tail re-reads for late-visible rows; a full sweep runs periodically.
export const LIVE_TAIL_OVERLAP_MS = 5_000;
export const LIVE_TAIL_SWEEP_OVERLAP_MS = 30_000;
export const LIVE_TAIL_SWEEP_INTERVAL_MS = 20_000;

export function tailOverlapMs(nowMs: number, lastSweepAtMs: number): number {
  return nowMs - lastSweepAtMs >= LIVE_TAIL_SWEEP_INTERVAL_MS
    ? LIVE_TAIL_SWEEP_OVERLAP_MS
    : LIVE_TAIL_OVERLAP_MS;
}

// Min spacing between tail reads, growing with trace size.
export function tailMinIntervalMs(loadedSpans: number): number {
  if (loadedSpans >= 100_000) return 15_000;
  if (loadedSpans >= 50_000) return 5_000;
  if (loadedSpans >= 5_000) return 2_000;
  return 0;
}

// Tail only when the server enabled it for a progressive payload.
export function resolveLiveTailEnabled(
  progressive: { liveTailEnabled?: boolean } | null | undefined
): boolean {
  return progressive != null && progressive.liveTailEnabled === true;
}
