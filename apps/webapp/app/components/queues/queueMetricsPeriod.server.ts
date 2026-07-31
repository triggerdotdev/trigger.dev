import { getLimit } from "~/services/platform.v3.server";
import { QUEUE_METRICS_RETENTION_DAYS } from "./queueMetricsPeriod";

/**
 * The furthest back this org can query queue metrics: their plan's query period, capped at the
 * 30 day retention. Same limit `executeQuery` enforces, so the queue-metric queries that bypass it
 * and go straight to ClickHouse stay in step with the ones that don't.
 */
export async function queueMetricsMaxPeriodDays(organizationId: string): Promise<number> {
  const planPeriodDays = await getLimit(
    organizationId,
    "queryPeriodDays",
    QUEUE_METRICS_RETENTION_DAYS
  );
  return Math.min(planPeriodDays, QUEUE_METRICS_RETENTION_DAYS);
}
