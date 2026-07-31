import { getCachedLimit } from "~/services/platform.v3.server";
import { logger } from "~/services/logger.server";
import { QUEUE_METRICS_RETENTION_DAYS } from "./queueMetricsPeriod";

/**
 * The furthest back this org can query queue metrics: their plan's query period, capped at the
 * 30 day retention. Same limit `executeQuery` enforces, so the queue-metric queries that bypass it
 * and go straight to ClickHouse stay in step with the ones that don't.
 *
 * Read through the limit cache: the queues page revalidates on an interval, so this runs far more
 * often than a one-off page load. Never throws, so a cache or platform outage costs the caller its
 * time filter rather than the whole page: the retention cap is the widest window the data can cover
 * anyway, and the queries stay tenant-scoped either way.
 */
export async function queueMetricsMaxPeriodDays(organizationId: string): Promise<number> {
  try {
    const cached = await getCachedLimit(
      organizationId,
      "queryPeriodDays",
      QUEUE_METRICS_RETENTION_DAYS
    );
    const planPeriodDays = cached.val ?? QUEUE_METRICS_RETENTION_DAYS;
    return Math.min(planPeriodDays, QUEUE_METRICS_RETENTION_DAYS);
  } catch (error) {
    logger.warn("Queue metrics query period limit unavailable, falling back to retention", {
      organizationId,
      error,
    });
    return QUEUE_METRICS_RETENTION_DAYS;
  }
}
