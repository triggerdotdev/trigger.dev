import type { WebhookEngineMetricsHooks } from "@internal/webhook-engine";
import { env } from "~/env.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { singleton } from "~/utils/singleton";
import { meter } from "~/v3/tracer.server";
import { webhookMetricsTenant } from "~/v3/webhookLimits.server";
import {
  apiRateLimitMetricsInsertSettings,
  exportApiRateLimitMetricRows,
} from "./apiRateLimitMetricsExporter.server";
import { logger } from "./logger.server";
import {
  createWebhookMetricsAggregator,
  webhookMetricsHooks,
  type WebhookMetricsAggregator,
  type WebhookMetricsTenant,
} from "./webhookMetricsAggregator.server";

/** Resolves the environment's tenant from cache, then records; never blocks the caller. */
export function withWebhookMetrics(
  environmentId: string,
  record: (metrics: WebhookMetricsAggregator, tenant: WebhookMetricsTenant) => void
): void {
  webhookMetricsTenant(environmentId)
    .then((tenant) => {
      if (tenant) record(getAggregator(), tenant);
    })
    .catch((error) => {
      logger.debug("webhook metrics: recording failed", {
        environmentId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export function webhookEngineMetricsHooks(): WebhookEngineMetricsHooks {
  return webhookMetricsHooks(withWebhookMetrics);
}

export function initWebhookMetrics(): void {
  getAggregator();
}

function getAggregator(): WebhookMetricsAggregator {
  return singleton("webhookMetricsAggregator", createAggregator);
}

function createAggregator(): WebhookMetricsAggregator {
  const droppedCounter = meter.createCounter("webhook_metrics.dropped", {
    description: "Webhook limit observations dropped at the in-process cap or before shutdown",
  });
  const flushedCounter = meter.createCounter("webhook_metrics.rows_flushed", {
    description: "Webhook limit metric rows sent to ClickHouse as async inserts",
  });
  const insertFailedCounter = meter.createCounter("webhook_metrics.rows_insert_failed", {
    description: "Webhook limit metric rows lost because ClickHouse rejected the insert request",
  });

  const aggregator = createWebhookMetricsAggregator({
    bucketSeconds: 10,
    maxEntries: env.WEBHOOK_METRICS_MAX_ENTRIES,
    maxSubjectsPerEntry: env.WEBHOOK_METRICS_MAX_ENDPOINTS,
    isEnabled: () => true,
    sink: (rows) =>
      exportApiRateLimitMetricRows(rows, {
        resolveClient: (organizationId) =>
          clickhouseFactory.getClickhouseForOrganizationSync(organizationId, "events"),
        settings: apiRateLimitMetricsInsertSettings({
          waitForAsyncInsert: false,
          busyTimeoutMs: env.API_RATE_LIMIT_METRICS_INSERT_BUSY_TIMEOUT_MS,
        }),
        onInsertError: (failedRows, error) => {
          insertFailedCounter.add(failedRows);
          logger.error("webhook metrics: clickhouse rejected the insert request, dropping rows", {
            rows: failedRows,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      }),
    counters: { dropped: droppedCounter, rowsFlushed: flushedCounter },
    flushIntervalMs: env.WEBHOOK_METRICS_FLUSH_INTERVAL_MS,
    ready: clickhouseFactory.isReady(),
  });
  aggregator.start();

  return aggregator;
}
