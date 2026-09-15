/** Shared bucketing + zero-fill helpers for the task/agent activity bar charts. */

// Snap bucket intervals to human-friendly values (1s…7d) so tick boundaries stay readable.
const NICE_BUCKET_SECONDS = [
  1, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800,
  604800,
] as const;

export type ChooseBucketOptions = {
  /** Bucket count to aim for (a "full"-looking chart). */
  targetBuckets?: number;
  /** Hard ceiling so we never emit sub-pixel bars or huge result sets. */
  maxBuckets?: number;
};

/**
 * Pick a bucket interval (seconds): the nice value whose bucket count is closest
 * to `targetBuckets` without exceeding `maxBuckets`. Keeps a 5-minute range from
 * collapsing to a single 1-hour bar.
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
    if (count > maxBuckets) continue;
    const score = Math.abs(count - targetBuckets);
    if (score < bestScore) {
      bestScore = score;
      best = secs;
    }
  }

  // Range larger than the ladder: derive an interval that respects the ceiling.
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
 * Zero-filled grouped series: every bucket in [from, to) is emitted and every
 * `orderedKeys` entry is present on each point, for contiguous bars and a stable
 * legend.
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
  /** Maps a raw status to a key; defaults to identity. */
  groupFn?: (status: string) => K | undefined;
  /** Key for statuses groupFn doesn't map (e.g. unknown statuses). */
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

/** Zero-filled single-series (scalar) time series. */
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
