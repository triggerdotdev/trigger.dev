/**
 * Shared helpers for the task/agent "activity" bar charts.
 *
 * These were previously duplicated across AgentDetailPresenter and
 * TaskDetailPresenter (bucket-size ladder, run-status grouping, and the
 * zero-fill loop). Centralising them fixes the "sub-hour range renders one
 * 1h bar" problem in one place and keeps the three task landing pages
 * consistent.
 */

// Nice, human-friendly bucket intervals (seconds). toStartOfInterval accepts
// any integer, but snapping to these keeps tick boundaries readable.
const NICE_BUCKET_SECONDS = [
  1, 5, 10, 15, 30, // sub-minute
  60, 120, 300, 600, 900, 1800, // 1m, 2m, 5m, 10m, 15m, 30m
  3600, 7200, 10800, 21600, 43200, // 1h, 2h, 3h, 6h, 12h
  86400, 172800, 604800, // 1d, 2d, 7d
] as const;

export type ChooseBucketOptions = {
  /** Bucket count we aim for — produces a chart that looks "full". */
  targetBuckets?: number;
  /** Hard ceiling so we never emit sub-pixel bars / huge result sets. */
  maxBuckets?: number;
};

/**
 * Choose a bucket interval (in seconds) for a time range so the chart renders
 * a sensible number of bars regardless of how short or long the range is.
 *
 * Picks the nice interval whose resulting bucket count is closest to
 * `targetBuckets` without exceeding `maxBuckets`. A 5-minute range becomes
 * ~5s buckets (≈60 bars) instead of a single 1-hour bar.
 */
export function chooseBucketSeconds(
  rangeMs: number,
  { targetBuckets = 72, maxBuckets = 120 }: ChooseBucketOptions = {}
): number {
  const rangeSeconds = Math.max(1, Math.ceil(rangeMs / 1000));

  let best: number | null = null;
  let bestScore = Infinity;
  for (const secs of NICE_BUCKET_SECONDS) {
    const count = rangeSeconds / secs;
    if (count > maxBuckets) continue; // too many bars
    const score = Math.abs(count - targetBuckets);
    if (score < bestScore) {
      bestScore = score;
      best = secs;
    }
  }

  // No nice interval keeps us under maxBuckets (range larger than the ladder) —
  // compute one that respects the ceiling.
  if (best === null) {
    return Math.ceil(rangeSeconds / maxBuckets);
  }

  return best;
}

export const RUN_STATUS_GROUPS = ["COMPLETED", "FAILED", "CANCELED", "RUNNING"] as const;
export type RunStatusGroup = (typeof RUN_STATUS_GROUPS)[number];

const TERMINAL_GROUPS: Record<RunStatusGroup, readonly string[]> = {
  COMPLETED: ["COMPLETED_SUCCESSFULLY"],
  FAILED: ["COMPLETED_WITH_ERRORS", "SYSTEM_FAILURE", "CRASHED", "INTERRUPTED", "TIMED_OUT"],
  CANCELED: ["CANCELED", "EXPIRED"],
  RUNNING: [
    "EXECUTING",
    "DEQUEUED",
    "PENDING_EXECUTING",
    "WAITING_TO_RESUME",
    "QUEUED_EXECUTING",
    "PENDING",
    "PENDING_VERSION",
    "DELAYED",
    "WAITING_FOR_DEPLOY",
  ],
};

/** Map a raw TaskRun status to one of the four chart groups. */
export function groupRunStatus(status: string): RunStatusGroup | undefined {
  for (const label of RUN_STATUS_GROUPS) {
    if (TERMINAL_GROUPS[label].includes(status)) return label;
  }
  return undefined;
}

export type ActivitySeriesPoint = { bucket: number } & Record<string, number>;

function bucketBounds(from: Date, to: Date, bucketSeconds: number) {
  const bucketMs = bucketSeconds * 1000;
  return {
    bucketMs,
    start: Math.floor(from.getTime() / bucketMs) * bucketMs,
    end: Math.ceil(to.getTime() / bucketMs) * bucketMs,
  };
}

/**
 * Build a zero-filled, grouped time series. Every bucket across [from, to) is
 * emitted (even empty ones) and every key in `orderedKeys` is present on every
 * point, so the chart renders contiguous bars and a stable legend.
 */
export function zeroFillGroupedSeries<K extends string>({
  rows,
  from,
  to,
  bucketSeconds,
  orderedKeys,
  groupFn,
  fallbackKey,
}: {
  rows: Array<{ bucket: number; status: string; val: number }>;
  from: Date;
  to: Date;
  bucketSeconds: number;
  orderedKeys: readonly K[];
  /** Maps a raw status to a key. Defaults to identity (status === key). */
  groupFn?: (status: string) => K | undefined;
  /** Key to use when groupFn returns undefined (e.g. unknown statuses). */
  fallbackKey?: K;
}): ActivitySeriesPoint[] {
  const bucketMap = new Map<number, Record<string, number>>();
  for (const row of rows) {
    const key = (groupFn ? groupFn(row.status) : (row.status as K)) ?? fallbackKey;
    if (!key) continue;
    const ts = row.bucket * 1000;
    const existing = bucketMap.get(ts) ?? {};
    existing[key] = (existing[key] ?? 0) + row.val;
    bucketMap.set(ts, existing);
  }

  const { bucketMs, start, end } = bucketBounds(from, to, bucketSeconds);
  const points: ActivitySeriesPoint[] = [];
  for (let ts = start; ts < end; ts += bucketMs) {
    const existing = bucketMap.get(ts) ?? {};
    const point: ActivitySeriesPoint = { bucket: ts };
    for (const k of orderedKeys) point[k] = existing[k] ?? 0;
    points.push(point);
  }
  return points;
}

/** Build a zero-filled single-series (scalar) time series. */
export function zeroFillScalarSeries({
  rows,
  from,
  to,
  bucketSeconds,
  seriesKey,
}: {
  rows: Array<{ bucket: number; val: number }>;
  from: Date;
  to: Date;
  bucketSeconds: number;
  seriesKey: string;
}): ActivitySeriesPoint[] {
  const bucketMap = new Map<number, number>();
  for (const row of rows) {
    const ts = row.bucket * 1000;
    bucketMap.set(ts, (bucketMap.get(ts) ?? 0) + row.val);
  }

  const { bucketMs, start, end } = bucketBounds(from, to, bucketSeconds);
  const points: ActivitySeriesPoint[] = [];
  for (let ts = start; ts < end; ts += bucketMs) {
    points.push({ bucket: ts, [seriesKey]: bucketMap.get(ts) ?? 0 });
  }
  return points;
}
