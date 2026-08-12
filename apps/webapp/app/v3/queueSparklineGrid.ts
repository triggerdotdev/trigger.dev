/**
 * Bucket grid for the Queues list sparklines. Pure so it can be unit tested: the presenter that
 * uses it reaches ClickHouse, and the grid arithmetic is where the off-by-one lives.
 *
 * The grid start floors to a bucket boundary and the end ceils to one, so repeated loads inside a
 * bucket produce identical query params and share ClickHouse query-cache entries. That means the
 * span covered by the grid is wider than the requested range whenever `from` is not already on a
 * boundary, which is almost always. `bucketCount` is therefore measured from the aligned grid
 * start rather than from the raw range, otherwise the newest bucket lands at an index the caller
 * treats as out of range and its data is silently dropped.
 */

export const SPARKLINE_POINTS = 48;

const MIN_RANGE_SECONDS = 60;
const MIN_BUCKET_SECONDS = 60;

export type SparklineGrid = {
  bucketSeconds: number;
  bucketIntervalMs: number;
  /** Aligned grid start; at or before the requested `from`. */
  bucketStartMs: number;
  /** Aligned grid end; at or after the requested `to`. */
  endMs: number;
  /** Buckets spanning bucketStartMs..endMs, so every bucket the query can return has an index. */
  bucketCount: number;
};

export function computeSparklineGrid(from: Date, to: Date): SparklineGrid {
  const rangeSeconds = Math.max(
    MIN_RANGE_SECONDS,
    Math.round((to.getTime() - from.getTime()) / 1000)
  );
  const bucketSeconds = Math.max(MIN_BUCKET_SECONDS, Math.round(rangeSeconds / SPARKLINE_POINTS));
  const bucketIntervalMs = bucketSeconds * 1000;

  const gridStartSeconds =
    Math.floor(Math.floor(from.getTime() / 1000) / bucketSeconds) * bucketSeconds;
  const bucketStartMs = gridStartSeconds * 1000;
  const endMs = Math.ceil(to.getTime() / bucketIntervalMs) * bucketIntervalMs;

  const bucketCount = Math.max(1, Math.round((endMs - bucketStartMs) / bucketIntervalMs));

  return { bucketSeconds, bucketIntervalMs, bucketStartMs, endMs, bucketCount };
}

/** Index of a bucket on the grid, or null when it falls outside it. */
export function bucketIndex(grid: SparklineGrid, bucketMs: number): number | null {
  const index = Math.round((bucketMs - grid.bucketStartMs) / grid.bucketIntervalMs);
  if (index < 0 || index >= grid.bucketCount) {
    return null;
  }
  return index;
}
