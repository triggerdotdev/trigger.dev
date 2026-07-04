import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { logger } from "~/services/logger.server";

export type QueueListMetric = {
  p50WaitMs: number | null;
  p95WaitMs: number | null;
  peakQueued: number;
  /** Equal-width buckets, oldest first, carry-forward filled across idle gaps. */
  depthSparkline: number[];
};

export type QueueListMetrics = {
  bucketStartMs: number;
  bucketIntervalMs: number;
  byQueue: Map<string, QueueListMetric>;
};

const SPARKLINE_POINTS = 48;

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
    const rangeSeconds = Math.max(60, Math.round((to.getTime() - from.getTime()) / 1000));
    const bucketSeconds = Math.max(60, Math.round(rangeSeconds / SPARKLINE_POINTS));
    const numBuckets = Math.max(1, Math.ceil(rangeSeconds / bucketSeconds));
    const gridStartSeconds =
      Math.floor(Math.floor(from.getTime() / 1000) / bucketSeconds) * bucketSeconds;
    const bucketStartMs = gridStartSeconds * 1000;
    const bucketIntervalMs = bucketSeconds * 1000;

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
        "query"
      );

      const ids = {
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        environmentId: environment.id,
        queueNames,
        startTime: formatClickhouseDateTime(new Date(bucketStartMs)),
        endTime: formatClickhouseDateTime(to),
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

      // Bucket -> depth per queue, mapped onto the aligned grid and forward-filled.
      const depthsByQueue = new Map<string, Map<number, number>>();
      for (const row of sparklineRows ?? []) {
        const bucketMs = Date.parse(row.bucket.replace(" ", "T") + "Z");
        if (Number.isNaN(bucketMs)) continue;
        const index = Math.round((bucketMs - bucketStartMs) / bucketIntervalMs);
        if (index < 0 || index >= numBuckets) continue;
        let byIndex = depthsByQueue.get(row.queue_name);
        if (!byIndex) {
          byIndex = new Map();
          depthsByQueue.set(row.queue_name, byIndex);
        }
        byIndex.set(index, row.depth);
      }

      const byQueue = new Map<string, QueueListMetric>();
      for (const row of summaryRows ?? []) {
        const byIndex = depthsByQueue.get(row.queue_name);
        const sparkline: number[] = new Array(numBuckets);
        let last = 0;
        for (let i = 0; i < numBuckets; i++) {
          const value = byIndex?.get(i);
          if (value !== undefined) last = value;
          sparkline[i] = last;
        }
        byQueue.set(row.queue_name, {
          p50WaitMs: finiteOrNull(row.p50_wait_ms),
          p95WaitMs: finiteOrNull(row.p95_wait_ms),
          peakQueued: row.peak_queued,
          depthSparkline: sparkline,
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
