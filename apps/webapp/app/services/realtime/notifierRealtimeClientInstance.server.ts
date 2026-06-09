import { Counter, Gauge, Histogram } from "prom-client";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { metricsRegister } from "~/metrics.server";
import { singleton } from "~/utils/singleton";
import { getCachedLimit } from "../platform.v3.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { ClickHouseRunListResolver } from "./clickHouseRunListResolver.server";
import { NotifierRealtimeClient } from "./notifierRealtimeClient.server";
import { RealtimeConcurrencyLimiter } from "./realtimeConcurrencyLimiter.server";
import { getRunChangeNotifier } from "./runChangeNotifierInstance.server";
import { RunHydrator } from "./runReader.server";

/**
 * Process-singleton wiring for the notifier-backed realtime client. Only
 * constructed when a request actually routes to the
 * notifier backend, so a disabled webapp never instantiates it.
 */
function initializeNotifierRealtimeClient(): NotifierRealtimeClient {
  const wakeups = new Counter({
    name: "realtime_notifier_wakeups_total",
    help: "Live realtime notifier wakeups by reason. A rising 'timeout' share suggests a write site is missing its publishRunChanged delegate.",
    labelNames: ["reason"] as const,
    registers: [metricsRegister],
  });

  const runSetResolves = new Counter({
    name: "realtime_notifier_runset_resolve_total",
    help: "Multi-run (tag-list/batch) resolve+hydrate outcomes. 'hit'/'coalesced' vs 'miss' shows how effectively concurrent same-filter feeds share a single ClickHouse + Postgres query under an env-wide wake.",
    labelNames: ["result"] as const,
    registers: [metricsRegister],
  });

  const runSetQueryMs = new Histogram({
    name: "realtime_notifier_runset_query_ms",
    help: "Latency of the multi-run resolve (ClickHouse) and hydrate (Postgres) stages.",
    labelNames: ["stage"] as const,
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000],
    registers: [metricsRegister],
  });

  const limiter = new RealtimeConcurrencyLimiter({
    keyPrefix: "tr:realtime:notifier:concurrency",
    redis: {
      port: env.RATE_LIMIT_REDIS_PORT,
      host: env.RATE_LIMIT_REDIS_HOST,
      username: env.RATE_LIMIT_REDIS_USERNAME,
      password: env.RATE_LIMIT_REDIS_PASSWORD,
      tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
      clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
    },
  });

  const client = new NotifierRealtimeClient({
    runReader: new RunHydrator({ replica: $replica }),
    runListResolver: new ClickHouseRunListResolver({
      getClickhouse: (organizationId) =>
        clickhouseFactory.getClickhouseForOrganization(organizationId, "realtime"),
      prisma: $replica,
    }),
    notifier: getRunChangeNotifier(),
    limiter,
    cachedLimitProvider: {
      async getCachedLimit(organizationId, defaultValue) {
        const result = await getCachedLimit(
          organizationId,
          "realtimeConcurrentConnections",
          defaultValue
        );
        return result.val;
      },
    },
    livePollTimeoutMs: env.REALTIME_NOTIFIER_LIVE_POLL_TIMEOUT_MS,
    maximumCreatedAtFilterAgeMs: env.REALTIME_MAXIMUM_CREATED_AT_FILTER_AGE_IN_MS,
    maxListResults: env.REALTIME_NOTIFIER_MAX_LIST_RESULTS,
    runSetResolveCacheTtlMs: env.REALTIME_NOTIFIER_RUNSET_CACHE_TTL_MS,
    runSetResolveCacheMaxEntries: env.REALTIME_NOTIFIER_RUNSET_CACHE_MAX_ENTRIES,
    listCacheMaxEntries: env.REALTIME_NOTIFIER_WORKING_SET_MAX_ENTRIES,
    runSetCreatedAtBucketMs: env.REALTIME_NOTIFIER_RUNSET_CREATED_AT_BUCKET_MS,
    holdOnEmpty: env.REALTIME_NOTIFIER_HOLD_ON_EMPTY === "1",
    onWakeup: (reason) => wakeups.inc({ reason }),
    onRunSetResolve: (result) => runSetResolves.inc({ result }),
    onRunSetQuery: (stage, ms) => runSetQueryMs.observe({ stage }, ms),
  });

  new Gauge({
    name: "realtime_notifier_working_set_size",
    help: "Entries in the per-handle working-set cache (one per active multi-run feed session).",
    registers: [metricsRegister],
    collect() {
      this.set(client.workingSetCacheSize);
    },
  });

  return client;
}

export function getNotifierRealtimeClient(): NotifierRealtimeClient {
  return singleton("notifierRealtimeClient", initializeNotifierRealtimeClient);
}
