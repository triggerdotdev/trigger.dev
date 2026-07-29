import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { logger } from "~/services/logger.server";
import { computeSparklineGrid } from "~/v3/queueSparklineGrid";

export type QueueListMetric = {
  p50WaitMs: number | null;
  p95WaitMs: number | null;
  peakQueued: number;
  /** Times this queue was throttled (running at limit with a backlog) over the window. */
  throttledTotal: number;
  /** Equal-width buckets, oldest first, carry-forward filled across idle gaps. */
  depthSparkline: number[];
  /**
   * Throttled count per bucket, aligned 1:1 with `depthSparkline`. Not carry-forward filled —
   * a bucket is non-zero only when throttling actually happened in it, so callers can tint
   * exactly those bars.
   */
  throttledSparkline: number[];
};

export type QueueListMetrics = {
  bucketStartMs: number;
  bucketIntervalMs: number;
  byQueue: Map<string, QueueListMetric>;
};

function formatClickhouseDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export class QueueMetricsPresenter {
  /**
   * Per-queue metrics over a time range for a fixed set of queues (the visible list page),
   * scoped to one ClickHouse query window so cost is independent of total queue count.
   * Degrades to an empty map if ClickHouse is unavailable so the live list still renders.
   */
  public async getQueueListMetrics({
    environment,
    queueNames,
    from,
    to,
  }: {
    environment: AuthenticatedEnvironment;
    queueNames: string[];
    from: Date;
    to: Date;
  }): Promise<QueueListMetrics> {
    const grid = computeSparklineGrid(from, to);
    const { bucketSeconds, bucketIntervalMs, bucketStartMs } = grid;
    const numBuckets = grid.bucketCount;

    const empty: QueueListMetrics = {
      bucketStartMs,
      bucketIntervalMs,
      byQueue: new Map(),
    };

    if (queueNames.length === 0) {
      return empty;
    }

    try {
      const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
        environment.organizationId,
        "queueMetrics"
      );

      const endMs = grid.endMs;
      const ids = {
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        environmentId: environment.id,
        queueNames,
        startTime: formatClickhouseDateTime(new Date(bucketStartMs)),
        endTime: formatClickhouseDateTime(new Date(endMs)),
      };

      const [summaryResult, sparklineResult] = await Promise.all([
        clickhouse.queueMetrics.listSummary(ids),
        clickhouse.queueMetrics.depthSparklines({ ...ids, bucketSeconds }),
      ]);

      const [summaryError, summaryRows] = summaryResult;
      const [sparklineError, sparklineRows] = sparklineResult;

      if (summaryError || sparklineError) {
        logger.warn("QueueMetricsPresenter: clickhouse query failed", {
          summaryError: summaryError?.message,
          sparklineError: sparklineError?.message,
        });
        return empty;
      }

      // Bucket -> depth + throttled per queue, mapped onto the aligned grid. Depth is
      // forward-filled below; throttled is not (only real per-bucket counts tint bars).
      const bucketsByQueue = new Map<string, Map<number, { depth: number; throttled: number }>>();
      for (const row of sparklineRows ?? []) {
        const bucketMs = Date.parse(row.bucket.replace(" ", "T") + "Z");
        if (Number.isNaN(bucketMs)) continue;
        const index = Math.round((bucketMs - bucketStartMs) / bucketIntervalMs);
        if (index < 0 || index >= numBuckets) continue;
        let byIndex = bucketsByQueue.get(row.queue_name);
        if (!byIndex) {
          byIndex = new Map();
          bucketsByQueue.set(row.queue_name, byIndex);
        }
        byIndex.set(index, { depth: row.depth, throttled: row.throttled });
      }

      const byQueue = new Map<string, QueueListMetric>();
      for (const row of summaryRows ?? []) {
        const byIndex = bucketsByQueue.get(row.queue_name);
        const sparkline: number[] = new Array(numBuckets);
        const throttledSparkline: number[] = new Array(numBuckets);
        let last = 0;
        for (let i = 0; i < numBuckets; i++) {
          const bucket = byIndex?.get(i);
          if (bucket !== undefined) last = bucket.depth;
          sparkline[i] = last;
          throttledSparkline[i] = bucket?.throttled ?? 0;
        }
        byQueue.set(row.queue_name, {
          p50WaitMs: finiteOrNull(row.p50_wait_ms),
          p95WaitMs: finiteOrNull(row.p95_wait_ms),
          peakQueued: row.peak_queued,
          throttledTotal: row.throttled_count,
          depthSparkline: sparkline,
          throttledSparkline,
        });
      }

      return { bucketStartMs, bucketIntervalMs, byQueue };
    } catch (error) {
      logger.warn("QueueMetricsPresenter: failed to load queue metrics", {
        error: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }
  }
}
