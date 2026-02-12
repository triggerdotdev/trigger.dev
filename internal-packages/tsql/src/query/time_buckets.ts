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
 * Time bucket thresholds: each entry defines a maximum time range duration (in seconds)
 * and the corresponding bucket interval to use.
 *
 * The intervals are chosen to produce roughly 50-100 data points for the given range.
 * Entries are ordered from smallest to largest range.
 */
const BUCKET_THRESHOLDS: Array<{ maxRangeSeconds: number; interval: TimeBucketInterval }> = [
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

/**
 * Calculate the most appropriate time bucket interval for a given time range.
 *
 * The interval is chosen to produce a reasonable number of data points (~50-100 buckets).
 * For very small ranges (< 5 minutes), uses 5-second buckets.
 * For very large ranges (> 365 days), uses 1-month buckets.
 *
 * @param from - Start of the time range
 * @param to - End of the time range
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
export function calculateTimeBucketInterval(from: Date, to: Date): TimeBucketInterval {
  const rangeSeconds = Math.abs(to.getTime() - from.getTime()) / 1000;

  for (const threshold of BUCKET_THRESHOLDS) {
    if (rangeSeconds < threshold.maxRangeSeconds) {
      return threshold.interval;
    }
  }

  return DEFAULT_LARGE_INTERVAL;
}
