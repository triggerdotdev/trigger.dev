/**
 * `getQueueDepthSparklines` emits a row only for buckets that reported, so a caller has to place
 * every row on the bucket grid itself. Depth is carry-forward filled: no emission means unchanged,
 * not zero. Throttled is not filled — only real per-bucket counts tint a bar.
 */

export type QueueDepthBucketRow = { bucket: string; depth: number; throttled: number };

export type QueueDepthGrid = { startMs: number; bucketIntervalMs: number; numBuckets: number };

/** Rows placed on the grid by bucket index. Rows outside the window are dropped. */
function indexQueueDepthRows(
  rows: QueueDepthBucketRow[],
  grid: QueueDepthGrid
): Map<number, { depth: number; throttled: number }> {
  const byIndex = new Map<number, { depth: number; throttled: number }>();
  for (const row of rows) {
    const bucketMs = Date.parse(row.bucket.replace(" ", "T") + "Z");
    if (Number.isNaN(bucketMs)) continue;
    const index = Math.round((bucketMs - grid.startMs) / grid.bucketIntervalMs);
    if (index < 0 || index >= grid.numBuckets) continue;
    byIndex.set(index, { depth: row.depth, throttled: row.throttled });
  }
  return byIndex;
}

/** A fixed-width series per grid bucket, so a gap can never shift later points in time. */
function fillQueueDepthSeries(
  byIndex: Map<number, { depth: number; throttled: number }>,
  numBuckets: number
): { depth: number[]; throttled: number[] } {
  const depth: number[] = new Array(numBuckets);
  const throttled: number[] = new Array(numBuckets);
  let last = 0;
  for (let i = 0; i < numBuckets; i++) {
    const bucket = byIndex.get(i);
    if (bucket !== undefined) last = bucket.depth;
    depth[i] = last;
    throttled[i] = bucket?.throttled ?? 0;
  }
  return { depth, throttled };
}

export function queueDepthSeries(
  rows: QueueDepthBucketRow[],
  grid: QueueDepthGrid
): { depth: number[]; throttled: number[] } {
  return fillQueueDepthSeries(indexQueueDepthRows(rows, grid), grid.numBuckets);
}
