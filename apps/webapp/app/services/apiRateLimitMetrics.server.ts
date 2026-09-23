import type { MetricsV1Input } from "@internal/clickhouse";
import { env } from "~/env.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { singleton } from "~/utils/singleton";
import { meter } from "~/v3/tracer.server";
import { ApiRateLimitMetricsAggregator } from "./apiRateLimitMetricsAggregator.server";
import {
  apiRateLimitMetricsInsertSettings,
  exportApiRateLimitMetricRows,
} from "./apiRateLimitMetricsExporter.server";
import type {
  RateLimitObservation,
  RateLimitTenant,
} from "./authorizationRateLimitMiddleware.server";
import { logger } from "./logger.server";
import { signalsEmitter } from "./signals.server";

function enabledByEnv(): boolean {
  return env.API_RATE_LIMIT_METRICS_ENABLED !== "0";
}

export function recordApiRateLimitObservation(observation: RateLimitObservation): void {
  if (!enabledByEnv()) {
    return;
  }
  getAggregator().record(observation);
}

/**
 * Builds the aggregator and starts its flush timer ahead of the first request.
 */
export function initApiRateLimitMetrics(): void {
  if (!enabledByEnv()) {
    return;
  }
  getAggregator();
}

function getAggregator(): ApiRateLimitMetricsAggregator {
  return singleton("apiRateLimitMetricsAggregator", createAggregator);
}

/**
 * With the env value "allowlist" only tenants whose organization carries the
 * apiRateLimitMetricsEnabled feature flag are recorded. The flag travels with the cached
 * rate-limit resolution, so this costs nothing per request. Turning recording off is a redeploy.
 */
function createRuntimeGate(): (tenant: RateLimitTenant) => boolean {
  if (env.API_RATE_LIMIT_METRICS_ENABLED === "1") {
    return () => true;
  }
  return (tenant) => tenant.metricsEnabled;
}

function exportRows(rows: MetricsV1Input[], onInsertError: (rows: number) => void): Promise<void> {
  return exportApiRateLimitMetricRows(rows, {
    resolveClient: (organizationId) =>
      clickhouseFactory.getClickhouseForOrganizationSync(organizationId, "events"),
    settings: apiRateLimitMetricsInsertSettings({
      waitForAsyncInsert: env.API_RATE_LIMIT_METRICS_WAIT_FOR_ASYNC_INSERT === "1",
      busyTimeoutMs: env.API_RATE_LIMIT_METRICS_INSERT_BUSY_TIMEOUT_MS,
    }),
    onInsertError: (failedRows, error) => {
      onInsertError(failedRows);
      logger.error(
        "api rate limit metrics: clickhouse rejected the insert request, dropping rows",
        {
          rows: failedRows,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    },
  });
}

function createAggregator(): ApiRateLimitMetricsAggregator {
  const droppedCounter = meter.createCounter("api_rate_limit_metrics.dropped", {
    description:
      "API rate limit observations dropped, by reason: the in-process cap was reached, or shutdown came before data store routing was ready",
  });
  const flushedCounter = meter.createCounter("api_rate_limit_metrics.rows_flushed", {
    description: "API rate limit metric rows sent to ClickHouse as async inserts",
  });
  const insertFailedCounter = meter.createCounter("api_rate_limit_metrics.rows_insert_failed", {
    description:
      "API rate limit metric rows lost because ClickHouse rejected the insert request; failures while writing a queued async insert are not visible here",
  });

  const aggregator = new ApiRateLimitMetricsAggregator({
    bucketSeconds: env.API_RATE_LIMIT_METRICS_BUCKET_SECONDS,
    maxEntries: env.API_RATE_LIMIT_METRICS_MAX_ENTRIES,
    isEnabled: createRuntimeGate(),
    sink: (rows) => exportRows(rows, (failed) => insertFailedCounter.add(failed)),
    onDropped: (count) => droppedCounter.add(count, { reason: "cap" }),
  });

  let routingReady = false;
  clickhouseFactory
    .isReady()
    .then(() => {
      routingReady = true;
    })
    .catch((error) => {
      logger.error("api rate limit metrics: data store registry never became ready", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

  let deferredWarned = false;
  const flush = () => {
    if (!routingReady) {
      if (aggregator.size > 0 && !deferredWarned) {
        deferredWarned = true;
        logger.warn("api rate limit metrics: flush deferred, data store routing not ready", {
          pendingEntries: aggregator.size,
        });
      }
      return;
    }
    try {
      const flushed = aggregator.flush();
      if (flushed > 0) {
        flushedCounter.add(flushed);
      }
    } catch (error) {
      logger.error("api rate limit metrics: flush failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const interval = setInterval(flush, env.API_RATE_LIMIT_METRICS_FLUSH_INTERVAL_MS);
  interval.unref();

  const shutdown = () => {
    clearInterval(interval);
    if (!routingReady) {
      const dropped = aggregator.discard();
      if (dropped > 0) {
        droppedCounter.add(dropped, { reason: "shutdown_before_ready" });
        logger.warn("api rate limit metrics: shutting down before routing was ready, dropping", {
          droppedObservations: dropped,
        });
      }
      return;
    }
    flush();
  };
  signalsEmitter.on("SIGTERM", shutdown);
  signalsEmitter.on("SIGINT", shutdown);

  return aggregator;
}
