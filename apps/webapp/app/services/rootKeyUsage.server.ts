import { ROOT_CONTEXT } from "@opentelemetry/api";
import type { AuthenticatedEnvironment } from "@trigger.dev/core/v3/auth/environment";
import type { BearerCredentialKind } from "@trigger.dev/rbac";
import { env } from "~/env.server";
import { createRedisClient } from "~/redis.server";
import { singleton } from "~/utils/singleton";
import { meter, SEMINTATTRS_FORCE_RECORDING, tracer } from "~/v3/tracer.server";
import { createRootKeyUsageAggregator } from "./rootKeyUsageAggregator.server";
import { exportRootKeyUsage } from "./rootKeyUsageExporter.server";

const FLUSH_INTERVAL_MS = 5 * 60_000;
// Rows carry no bucket downstream. Buckets much longer than the flush interval keep each
// environment to one buffer entry per flush, since flush timers are not clock-aligned.
const BUCKET_SECONDS = 60 * 60;
const MAX_ENVIRONMENT_BUCKETS = 1_000;
const REDIS_COMMAND_TIMEOUT_MS = 2_000;

const getAggregator = () =>
  singleton("rootKeyUsage", () => {
    const redis = createRedisClient("trigger:rootKeyUsage", {
      host: env.CACHE_REDIS_HOST,
      port: env.CACHE_REDIS_PORT,
      username: env.CACHE_REDIS_USERNAME,
      password: env.CACHE_REDIS_PASSWORD,
      tlsDisabled: env.CACHE_REDIS_TLS_DISABLED === "true",
      clusterMode: env.CACHE_REDIS_CLUSTER_MODE_ENABLED === "1",
      maxRetriesPerRequest: 1,
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    });
    const dropped = meter.createCounter("api_auth.tenant_usage_dropped", {
      description: "Tenant usage observations lost at the bounded environment buffer cap",
    });
    const exports = meter.createCounter("api_auth.tenant_usage_exports", {
      description:
        "Coalesced tenant usage rows emitted to the trace exporter (not delivery), suppressed by Redis, or lost on error",
    });
    dropped.add(0);
    for (const result of ["emitted", "coalesced", "error"] as const) {
      exports.add(0, { result });
    }

    const aggregator = createRootKeyUsageAggregator({
      bucketSeconds: BUCKET_SECONDS,
      flushIntervalMs: FLUSH_INTERVAL_MS,
      maxEntries: MAX_ENVIRONMENT_BUCKETS,
      counters: { dropped },
      sink: (rows) =>
        exportRootKeyUsage(
          rows,
          redis,
          (row) => {
            // Do not inherit request sampling or tenant context for these coalesced observations.
            tracer
              .startSpan(
                "api_auth.tenant_usage",
                {
                  attributes: {
                    [SEMINTATTRS_FORCE_RECORDING]: true,
                    "tenant_usage.organization_id": row.organization_id,
                    "tenant_usage.project_id": row.project_id,
                    "tenant_usage.environment_id": row.environment_id,
                    "tenant_usage.source": row.metric_name,
                    "tenant_usage.last_observed_ms": row.value,
                  },
                },
                ROOT_CONTEXT
              )
              .end();
          },
          (result, count) => exports.add(count, { result })
        ),
    });
    aggregator.start();
    return aggregator;
  });

export function recordRootKeyUsage(
  request: Request,
  credentialKind: BearerCredentialKind,
  environment: Pick<AuthenticatedEnvironment, "id" | "organizationId" | "projectId">
) {
  if (credentialKind !== "root_api_key" && credentialKind !== "run_token") return;
  getAggregator().record(request, credentialKind, environment);
}
