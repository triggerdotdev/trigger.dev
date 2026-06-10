import { Counter, Gauge, Histogram } from "prom-client";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { metricsRegister } from "~/metrics.server";
import { singleton } from "~/utils/singleton";
import { getCachedLimit } from "../platform.v3.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { ClickHouseRunListResolver } from "./clickHouseRunListResolver.server";
import { EnvChangeRouter } from "./envChangeRouter.server";
import { NativeRealtimeClient } from "./nativeRealtimeClient.server";
import { RealtimeConcurrencyLimiter } from "./realtimeConcurrencyLimiter.server";
import { getRunChangeNotifier } from "./runChangeNotifierInstance.server";
import { RunHydrator } from "./runReader.server";

// Process-singleton wiring for the native realtime client; only constructed when a
// request actually routes to it, so a disabled webapp never instantiates it.
function initializeNativeRealtimeClient(): NativeRealtimeClient {
  const wakeups = new Counter({
    name: "realtime_native_wakeups_total",
    help: "Live realtime wakeups by reason. A rising 'timeout' share suggests a write site is missing its publishChangeRecord delegate.",
    labelNames: ["reason"] as const,
    registers: [metricsRegister],
  });

  const runSetResolves = new Counter({
    name: "realtime_native_runset_resolve_total",
    help: "Multi-run (tag-list/batch) resolve+hydrate outcomes. 'hit'/'coalesced' vs 'miss' shows how effectively concurrent same-filter feeds share a single ClickHouse + Postgres query under an env-wide wake.",
    labelNames: ["result"] as const,
    registers: [metricsRegister],
  });

  const runSetQueryMs = new Histogram({
    name: "realtime_native_runset_query_ms",
    help: "Latency of the multi-run resolve (ClickHouse) and hydrate (Postgres) stages.",
    labelNames: ["stage"] as const,
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000],
    registers: [metricsRegister],
  });

  const livePollPaths = new Counter({
    name: "realtime_native_live_poll_total",
    help: "How live polls resolved. 'fast-hydrate' = the router woke the feed with matched runs hydrated by id (no ClickHouse); 'full-resolve' = the backstop timeout did a ClickHouse resolve. A high fast-path share is the local-membership routing working.",
    labelNames: ["path"] as const,
    registers: [metricsRegister],
  });

  const routerHydrates = new Counter({
    name: "realtime_native_router_hydrated_runs_total",
    help: "Runs hydrated by the EnvChangeRouter's batch-hydrate (one query per column set per wake, shared across all feeds matching the same run — the hot-shared-tag fan-out collapse).",
    registers: [metricsRegister],
  });

  const resolveAdmissionWaits = new Counter({
    name: "realtime_native_resolve_admission_waits_total",
    help: "Fresh ClickHouse resolves that had to queue for an admission permit. A rising count means a distinct-filter reconnect stampede is being throttled (the gate is doing its job).",
    registers: [metricsRegister],
  });

  const limiter = new RealtimeConcurrencyLimiter({
    keyPrefix: "tr:realtime:native:concurrency",
    redis: {
      port: env.RATE_LIMIT_REDIS_PORT,
      host: env.RATE_LIMIT_REDIS_HOST,
      username: env.RATE_LIMIT_REDIS_USERNAME,
      password: env.RATE_LIMIT_REDIS_PASSWORD,
      tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
      clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
    },
  });

  // One RunHydrator shared by the router and the client, so its single-flight + short-TTL cache covers both.
  const runReader = new RunHydrator({
    replica: $replica,
    cacheTtlMs: env.REALTIME_BACKEND_NATIVE_RUN_CACHE_TTL_MS,
    maxCacheEntries: env.REALTIME_BACKEND_NATIVE_RUN_CACHE_MAX_ENTRIES,
  });

  const router = new EnvChangeRouter({
    source: getRunChangeNotifier(),
    hydrator: runReader,
    onHydrate: (runCount) => routerHydrates.inc(runCount),
  });

  const client = new NativeRealtimeClient({
    runReader,
    runListResolver: new ClickHouseRunListResolver({
      getClickhouse: (organizationId) =>
        clickhouseFactory.getClickhouseForOrganization(organizationId, "realtime"),
      prisma: $replica,
    }),
    router,
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
    defaultConcurrencyLimit: env.REALTIME_BACKEND_NATIVE_DEFAULT_CONCURRENCY_LIMIT,
    livePollTimeoutMs: env.REALTIME_BACKEND_NATIVE_LIVE_POLL_TIMEOUT_MS,
    livePollJitterRatio: env.REALTIME_BACKEND_NATIVE_LIVE_POLL_JITTER_RATIO,
    maximumCreatedAtFilterAgeMs: env.REALTIME_MAXIMUM_CREATED_AT_FILTER_AGE_IN_MS,
    maxListResults: env.REALTIME_BACKEND_NATIVE_MAX_LIST_RESULTS,
    runSetResolveCacheTtlMs: env.REALTIME_BACKEND_NATIVE_RUNSET_CACHE_TTL_MS,
    runSetResolveCacheMaxEntries: env.REALTIME_BACKEND_NATIVE_RUNSET_CACHE_MAX_ENTRIES,
    listCacheMaxEntries: env.REALTIME_BACKEND_NATIVE_WORKING_SET_MAX_ENTRIES,
    workingSetCacheTtlMs: env.REALTIME_BACKEND_NATIVE_WORKING_SET_TTL_MS,
    runSetCreatedAtBucketMs: env.REALTIME_BACKEND_NATIVE_RUNSET_CREATED_AT_BUCKET_MS,
    holdOnEmpty: env.REALTIME_BACKEND_NATIVE_HOLD_ON_EMPTY === "1",
    resolveAdmissionLimit: env.REALTIME_BACKEND_NATIVE_RESOLVE_ADMISSION_LIMIT,
    onWakeup: (reason) => wakeups.inc({ reason }),
    onLivePollPath: (path) => livePollPaths.inc({ path }),
    onRunSetResolve: (result) => runSetResolves.inc({ result }),
    onRunSetQuery: (stage, ms) => runSetQueryMs.observe({ stage }, ms),
    onResolveAdmissionWait: () => resolveAdmissionWaits.inc(),
  });

  new Gauge({
    name: "realtime_native_working_set_size",
    help: "Entries in the per-handle working-set cache (one per active multi-run feed session).",
    registers: [metricsRegister],
    collect() {
      this.set(client.workingSetCacheSize);
    },
  });

  new Gauge({
    name: "realtime_native_resolve_admission_in_use",
    help: "Fresh ClickHouse resolves currently holding an admission permit (live concurrency against the gate's limit).",
    registers: [metricsRegister],
    collect() {
      this.set(client.resolveAdmissionInUse);
    },
  });

  return client;
}

export function getNativeRealtimeClient(): NativeRealtimeClient {
  return singleton("nativeRealtimeClient", initializeNativeRealtimeClient);
}
