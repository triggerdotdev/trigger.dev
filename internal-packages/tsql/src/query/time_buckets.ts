/**
 * Time bucket interval calculation for the `timeBucket()` TSQL function.
 *
 * Given a time range, determines the most appropriate bucket interval
 * to produce a reasonable number of data points (~50-100 buckets).
 */

/**
 * A time bucket interval with a numeric value and time unit.
 * Used to generate ClickHouse `INTERVAL N UNIT` syntax.
 */
export interface TimeBucketInterval {
  /** The numeric value of the interval (e.g., 5 for "5 MINUTE") */
  value: number;
  /** The time unit */
  unit: "SECOND" | "MINUTE" | "HOUR" | "DAY" | "WEEK" | "MONTH";
}

/**
 * A threshold mapping a maximum time range duration to a bucket interval.
 */
export interface BucketThreshold {
  /** Maximum range duration in seconds for this threshold to apply */
  maxRangeSeconds: number;
  /** The bucket interval to use when the range is under maxRangeSeconds */
  interval: TimeBucketInterval;
}

/**
 * Default time bucket thresholds: each entry defines a maximum time range duration (in seconds)
 * and the corresponding bucket interval to use.
 *
 * The intervals are chosen to produce roughly 50-100 data points for the given range.
 * Entries are ordered from smallest to largest range.
 */
export const BUCKET_THRESHOLDS: BucketThreshold[] = [
  // Under 5 minutes → 5 second buckets (max 60 buckets)
  { maxRangeSeconds: 5 * 60, interval: { value: 5, unit: "SECOND" } },
  // Under 30 minutes → 30 second buckets (max 60 buckets)
  { maxRangeSeconds: 30 * 60, interval: { value: 30, unit: "SECOND" } },
  // Under 2 hours → 1 minute buckets (max 120 buckets)
  { maxRangeSeconds: 2 * 60 * 60, interval: { value: 1, unit: "MINUTE" } },
  // Under 6 hours → 5 minute buckets (max 72 buckets)
  { maxRangeSeconds: 6 * 60 * 60, interval: { value: 5, unit: "MINUTE" } },
  // Under 24 hours → 15 minute buckets (max 96 buckets)
  { maxRangeSeconds: 24 * 60 * 60, interval: { value: 15, unit: "MINUTE" } },
  // Under 3 days → 1 hour buckets (max 72 buckets)
  { maxRangeSeconds: 3 * 24 * 60 * 60, interval: { value: 1, unit: "HOUR" } },
  // Under 14 days → 6 hour buckets (max 56 buckets)
  { maxRangeSeconds: 14 * 24 * 60 * 60, interval: { value: 6, unit: "HOUR" } },
  // Under 60 days → 1 day buckets (max 60 buckets)
  { maxRangeSeconds: 60 * 24 * 60 * 60, interval: { value: 1, unit: "DAY" } },
  // Under 365 days → 1 week buckets (max ~52 buckets)
  { maxRangeSeconds: 365 * 24 * 60 * 60, interval: { value: 1, unit: "WEEK" } },
];

/** Default interval for very large ranges (365+ days) */
const DEFAULT_LARGE_INTERVAL: TimeBucketInterval = { value: 1, unit: "MONTH" };

/** Seconds in each bucket unit. MONTH is nominal (30 days) and only used for comparisons. */
export const INTERVAL_UNIT_SECONDS: Record<TimeBucketInterval["unit"], number> = {
  SECOND: 1,
  MINUTE: 60,
  HOUR: 3600,
  DAY: 86400,
  WEEK: 604800,
  MONTH: 2592000,
};

/** Duration of a bucket interval, in seconds. */
export function intervalToSeconds(interval: TimeBucketInterval): number {
  return interval.value * INTERVAL_UNIT_SECONDS[interval.unit];
}

/**
 * Express a duration in seconds as a bucket interval, preferring the largest unit it divides
 * evenly into so the emitted `INTERVAL N UNIT` reads naturally (120 -> 2 MINUTE, not 120 SECOND).
 */
function secondsToInterval(seconds: number): TimeBucketInterval {
  const units: Array<TimeBucketInterval["unit"]> = ["WEEK", "DAY", "HOUR", "MINUTE"];
  for (const unit of units) {
    const unitSeconds = INTERVAL_UNIT_SECONDS[unit];
    if (seconds >= unitSeconds && seconds % unitSeconds === 0) {
      return { value: seconds / unitSeconds, unit };
    }
  }
  return { value: Math.max(1, Math.round(seconds)), unit: "SECOND" };
}

/**
 * Calculate the most appropriate time bucket interval for a given time range.
 *
 * The interval is chosen to produce a reasonable number of data points (~50-100 buckets).
 * For very small ranges (< 5 minutes), uses 5-second buckets.
 * For very large ranges (> 365 days), uses 1-month buckets.
 *
 * @param from - Start of the time range
 * @param to - End of the time range
 * @param thresholds - Table-specific thresholds, defaulting to `BUCKET_THRESHOLDS`
 * @param minBucketSeconds - Floor for the returned interval, for series whose samples are too
 *   sparse to be meaningful at the range's natural bucket width
 * @returns The recommended bucket interval
 *
 * @example
 * ```typescript
 * // 1 hour range → 1 minute buckets
 * calculateTimeBucketInterval(
 *   new Date("2024-01-01T00:00:00Z"),
 *   new Date("2024-01-01T01:00:00Z"),
 * ); // { value: 1, unit: "MINUTE" }
 *
 * // 7 day range → 6 hour buckets
 * calculateTimeBucketInterval(
 *   new Date("2024-01-01"),
 *   new Date("2024-01-08"),
 * ); // { value: 6, unit: "HOUR" }
 * ```
 */
export function calculateTimeBucketInterval(
  from: Date,
  to: Date,
  thresholds?: BucketThreshold[],
  minBucketSeconds?: number
): TimeBucketInterval {
  const rangeSeconds = Math.abs(to.getTime() - from.getTime()) / 1000;

  const interval = pickInterval(rangeSeconds, thresholds);

  if (minBucketSeconds !== undefined && intervalToSeconds(interval) < minBucketSeconds) {
    return secondsToInterval(minBucketSeconds);
  }

  return interval;
}

function pickInterval(rangeSeconds: number, thresholds?: BucketThreshold[]): TimeBucketInterval {
  for (const threshold of thresholds ?? BUCKET_THRESHOLDS) {
    if (rangeSeconds < threshold.maxRangeSeconds) {
      return threshold.interval;
    }
  }

  return DEFAULT_LARGE_INTERVAL;
}
