import { getMeter } from "@internal/tracing";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { getCachedLimit } from "../platform.v3.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { ClickHouseRunListResolver } from "./clickHouseRunListResolver.server";
import { EnvChangeRouter, type EnvChangeSource } from "./envChangeRouter.server";
import { NativeRealtimeClient } from "./nativeRealtimeClient.server";
import { RealtimeConcurrencyLimiter } from "./realtimeConcurrencyLimiter.server";
import { getRunChangeNotifier } from "./runChangeNotifierInstance.server";
import { RedisReplayCursorStore } from "./replayCursorStore.server";
import { createPostgresReplicaLagSource, ReplicaLagEstimator } from "./replicaLagEstimator.server";
import { RunHydrator } from "./runReader.server";

// Process-singleton wiring for the native realtime client; only constructed when a
// request actually routes to it, so a disabled webapp never instantiates it.
function initializeNativeRealtimeClient(): NativeRealtimeClient {
  const meter = getMeter("realtime-native");

  const wakeups = meter.createCounter("realtime_native.wakeups", {
    description:
      "Live realtime wakeups by reason. A rising 'timeout' share suggests a write site is missing its publishChangeRecord delegate.",
  });

  const runSetResolves = meter.createCounter("realtime_native.runset_resolves", {
    description:
      "Multi-run (tag-list/batch) resolve+hydrate outcomes. 'hit'/'coalesced' vs 'miss' shows how effectively concurrent same-filter feeds share a single ClickHouse + Postgres query.",
  });

  const runSetQueryMs = meter.createHistogram("realtime_native.runset_query_ms", {
    description: "Latency of the multi-run resolve (ClickHouse) and hydrate (Postgres) stages.",
    unit: "ms",
  });

  const livePollPaths = meter.createCounter("realtime_native.live_polls", {
    description:
      "How live polls resolved. 'fast-hydrate' = router wake with rows hydrated by id (no ClickHouse); 'full-resolve' = backstop; 'cold-resolve' = fresh env subscription probed once.",
  });

  const routerHydrates = meter.createCounter("realtime_native.router_hydrated_runs", {
    description:
      "Runs hydrated by the EnvChangeRouter's batch-hydrate (one query per column set per wake, shared across all feeds matching the same run).",
  });

  const resolveAdmissionWaits = meter.createCounter("realtime_native.resolve_admission_waits", {
    description:
      "Fresh ClickHouse resolves that had to queue for an admission permit. A rising count means a distinct-filter reconnect stampede is being throttled (the gate is doing its job).",
  });

  const replays = meter.createCounter("realtime_native.replays", {
    description:
      "Buffered change records replayed to a newly-armed feed (inter-poll gap recovery). 'delivered' = rows reached the feed; 'empty' = candidates hydrated but none survived the filter/diff.",
  });

  const replayEvictions = meter.createCounter("realtime_native.replay_evictions", {
    description:
      "Replay-buffer evictions. 'window' expiry is normal; 'cap' means an env churns more runs inside the window than the buffer holds (replay guarantee degrading — retune the knobs).",
  });

  const deliveryLagMs = meter.createHistogram("realtime_native.delivery_lag_ms", {
    description:
      "Live emissions: now minus the newest emitted row's updatedAt (PG clock vs app clock, so approximate). The end-to-end delivery SLI — a p99 near the backstop hold means wakes are being missed.",
    unit: "ms",
  });

  const emittedRows = meter.createHistogram("realtime_native.emitted_rows", {
    description:
      "Rows per live emission. Deltas should be small; a fat tail means working-set/offset-floor fallbacks are re-emitting full sets.",
    unit: "rows",
  });

  const backstops = meter.createCounter("realtime_native.backstops", {
    description:
      "Backstop full resolves by outcome. 'empty' is normal idle behavior; sustained 'delivered' means the notify/replay path missed changes — alert on it.",
  });

  const concurrencyRejections = meter.createCounter("realtime_native.concurrency_rejections", {
    description: "Polls rejected (429) by the per-env concurrency limiter.",
  });

  const replayCursorOps = meter.createCounter("realtime_native.replay_cursor_ops", {
    description:
      "Shared replay-cursor store operations by outcome. Errors degrade hops to cold resolves (watch live_polls{path='cold-resolve'} rise with them), never failed polls.",
  });

  const staleHydrates = meter.createCounter("realtime_native.stale_hydrates", {
    description:
      "Wake hydrates the read-your-writes tripwire caught reading behind the publish. 'recovered' = a retry delivered the fresh row; sustained 'gave_up' means replica lag is outrunning the retry budget.",
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

  // Fleet-shared replay cursors (one timestamp per connection) on the same Redis as the
  // change channel, so a load-balancer hop reads the connection's true inter-poll gap.
  const replayCursorStore =
    env.REALTIME_BACKEND_NATIVE_SHARED_REPLAY_CURSORS === "1"
      ? new RedisReplayCursorStore({
          redis: {
            host: env.REALTIME_BACKEND_NATIVE_PUBSUB_REDIS_HOST,
            port: env.REALTIME_BACKEND_NATIVE_PUBSUB_REDIS_PORT,
            username: env.REALTIME_BACKEND_NATIVE_PUBSUB_REDIS_USERNAME,
            password: env.REALTIME_BACKEND_NATIVE_PUBSUB_REDIS_PASSWORD,
            tlsDisabled: env.REALTIME_BACKEND_NATIVE_PUBSUB_REDIS_TLS_DISABLED === "true",
            clusterMode: env.REALTIME_BACKEND_NATIVE_PUBSUB_REDIS_CLUSTER_MODE_ENABLED === "1",
          },
          ttlMs: env.REALTIME_BACKEND_NATIVE_WORKING_SET_TTL_MS,
          onResult: (op, ok) => replayCursorOps.add(1, { op, result: ok ? "ok" : "error" }),
        })
      : undefined;

  // One RunHydrator shared by the router and the client, so its single-flight + short-TTL cache covers both.
  const runReader = new RunHydrator({
    replica: $replica,
    cacheTtlMs: env.REALTIME_BACKEND_NATIVE_RUN_CACHE_TTL_MS,
    maxCacheEntries: env.REALTIME_BACKEND_NATIVE_RUN_CACHE_MAX_ENTRIES,
  });

  // Read-your-writes gate: the estimator samples replica lag (reader-side only, paused
  // when idle) and the router delays wake hydrates by it, anchored to each record's
  // updatedAtMs — so a publish racing the replica's apply is waited out, not read stale.
  const lagEstimator =
    env.REALTIME_BACKEND_NATIVE_REPLICA_LAG_GATE_ENABLED === "1"
      ? new ReplicaLagEstimator({
          source: createPostgresReplicaLagSource($replica),
          sampleIntervalMs: env.REALTIME_BACKEND_NATIVE_REPLICA_LAG_SAMPLE_INTERVAL_MS,
          idleAfterMs: env.REALTIME_BACKEND_NATIVE_REPLICA_LAG_IDLE_AFTER_MS,
          windowMs: env.REALTIME_BACKEND_NATIVE_REPLICA_LAG_WINDOW_MS,
          defaultLagMs: env.REALTIME_BACKEND_NATIVE_REPLICA_LAG_DEFAULT_MS,
          observedFloorTtlMs: env.REALTIME_BACKEND_NATIVE_REPLICA_LAG_OBSERVED_FLOOR_TTL_MS,
        })
      : undefined;

  // The notifier wrapped so router activity keeps the lag sampler warm.
  const notifier = getRunChangeNotifier();
  const source: EnvChangeSource = lagEstimator
    ? {
        subscribeToEnv(environmentId, onBatch) {
          lagEstimator.touch();
          return notifier.subscribeToEnv(environmentId, (records) => {
            lagEstimator.touch();
            onBatch(records);
          });
        },
      }
    : notifier;

  const router = new EnvChangeRouter({
    source,
    hydrator: runReader,
    onHydrate: (runCount) => routerHydrates.add(runCount),
    replayWindowMs: env.REALTIME_BACKEND_NATIVE_REPLAY_WINDOW_MS,
    replayMaxRunsPerEnv: env.REALTIME_BACKEND_NATIVE_REPLAY_MAX_RUNS,
    unsubscribeLingerMs: env.REALTIME_BACKEND_NATIVE_UNSUBSCRIBE_LINGER_MS,
    onReplay: (result) => replays.add(1, { result }),
    onReplayEviction: (reason) => replayEvictions.add(1, { reason }),
    replicaLag: lagEstimator
      ? {
          getLagMs: () => lagEstimator.getLagMs(),
          noteObservedLagMs: (lagMs) => lagEstimator.noteObservedLagMs(lagMs),
          marginMs: env.REALTIME_BACKEND_NATIVE_REPLICA_LAG_MARGIN_MS,
          maxDelayMs: env.REALTIME_BACKEND_NATIVE_REPLICA_LAG_MAX_DELAY_MS,
          staleRetries: env.REALTIME_BACKEND_NATIVE_STALE_HYDRATE_RETRIES,
          onStaleHydrate: (outcome, runCount) => staleHydrates.add(runCount, { outcome }),
        }
      : undefined,
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
    replayCursorStore,
    onWakeup: (reason) => wakeups.add(1, { reason }),
    onLivePollPath: (path) => livePollPaths.add(1, { path }),
    onRunSetResolve: (result) => runSetResolves.add(1, { result }),
    onRunSetQuery: (stage, ms) => runSetQueryMs.record(ms, { stage }),
    onResolveAdmissionWait: () => resolveAdmissionWaits.add(1),
    onEmit: (path, lagMs, rowCount) => {
      deliveryLagMs.record(Math.max(lagMs, 0), { path });
      emittedRows.record(rowCount);
    },
    onBackstopResult: (result) => backstops.add(1, { result }),
    onConcurrencyRejected: () => concurrencyRejections.add(1),
  });

  meter
    .createObservableGauge("realtime_native.working_set_size", {
      description:
        "Entries in the per-handle working-set cache (one per active multi-run feed session).",
    })
    .addCallback((result) => result.observe(client.workingSetCacheSize));

  meter
    .createObservableGauge("realtime_native.resolve_admission_in_use", {
      description:
        "Fresh ClickHouse resolves currently holding an admission permit (live concurrency against the gate's limit).",
    })
    .addCallback((result) => result.observe(client.resolveAdmissionInUse));

  meter
    .createObservableGauge("realtime_native.held_feeds", {
      description: "Long-polls currently held, by feed kind — the system's capacity unit.",
    })
    .addCallback((result) => {
      const counts = router.heldFeedCounts;
      result.observe(counts.run, { kind: "run" });
      result.observe(counts.tag, { kind: "tag" });
      result.observe(counts.batch, { kind: "batch" });
    });

  meter
    .createObservableGauge("realtime_native.active_envs", {
      description:
        "Environments currently routed on this instance (held feeds + lingering subscriptions).",
    })
    .addCallback((result) => result.observe(router.activeEnvCount));

  if (lagEstimator) {
    meter
      .createObservableGauge("realtime_native.replica_lag_estimate_ms", {
        description:
          "The read-your-writes gate's current replica-lag estimate (max sample in the window). Wake hydrates are delayed by roughly this much past each change's commit.",
      })
      .addCallback((result) => result.observe(lagEstimator.getLagMs()));
  }

  return client;
}

export function getNativeRealtimeClient(): NativeRealtimeClient {
  return singleton("nativeRealtimeClient", initializeNativeRealtimeClient);
}
