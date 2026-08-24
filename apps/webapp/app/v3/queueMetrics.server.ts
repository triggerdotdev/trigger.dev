import { type ClickHouse, type QueueMetricsRawV1Input } from "@internal/clickhouse";
import {
  allStreamKeys,
  CachedRedisFlag,
  CachedRedisNumber,
  MetricsStreamConsumer,
  MetricsStreamEmitter,
  probeShardStates,
  type MetricDefinition,
  type ShardState,
  type StreamEntry,
} from "@internal/metrics-pipeline";
import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import os from "node:os";
import { env } from "~/env.server";
import { getQueueMetricsClickhouseClient } from "~/services/clickhouse/clickhouseFactory.server";
import { logger } from "~/services/logger.server";
import { signalsEmitter } from "~/services/signals.server";
import { singleton } from "~/utils/singleton";
import { mapEntryToRows, QueueNameLimiter } from "./queueMetricsMapping";
import { meter } from "./tracer.server";

const FLAG_KEY = "queue_metrics:enabled";
const SAMPLE_RATE_KEY = "queue_metrics:gauge_sample_rate";
const TRUTHY = new Set(["1", "true", "on", "enabled", "yes"]);

// Same physical Redis as the RunQueue (host/port/auth). Stream keys are kept out of the
// keyPrefix on every access path, so only the connection details matter here.
function runQueueRedisOptions(): RedisOptions {
  return {
    port: env.RUN_ENGINE_RUN_QUEUE_REDIS_PORT ?? undefined,
    host: env.RUN_ENGINE_RUN_QUEUE_REDIS_HOST ?? undefined,
    username: env.RUN_ENGINE_RUN_QUEUE_REDIS_USERNAME ?? undefined,
    password: env.RUN_ENGINE_RUN_QUEUE_REDIS_PASSWORD ?? undefined,
    enableAutoPipelining: true,
    ...(env.RUN_ENGINE_RUN_QUEUE_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  };
}

// Metrics stream Redis: a dedicated instance when QUEUE_METRICS_REDIS_HOST is set (so the
// metrics backlog never competes with the run queue), else the run-queue Redis. Carries BOTH
// gauges and counters — gauges are read inside the queue-op Lua and returned on the reply,
// then XADDed here by Node, so the run-queue Redis holds no metrics stream.
function metricsRedisOptions(): RedisOptions {
  if (!env.QUEUE_METRICS_REDIS_HOST) return runQueueRedisOptions();
  return {
    host: env.QUEUE_METRICS_REDIS_HOST,
    port: env.QUEUE_METRICS_REDIS_PORT ?? undefined,
    username: env.QUEUE_METRICS_REDIS_USERNAME ?? undefined,
    password: env.QUEUE_METRICS_REDIS_PASSWORD ?? undefined,
    enableAutoPipelining: true,
    ...(env.QUEUE_METRICS_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  };
}

// One stream family on the metrics Redis carrying both gauge snapshots and cumulative
// counter readings; one consumer group reads it.
function metricsDefinition(): MetricDefinition {
  // A stalled consumer holds up to maxLen entries per shard in Redis memory: cap lower
  // by default when the stream shares the queue-critical run-queue Redis.
  const defaultMaxLen = env.QUEUE_METRICS_REDIS_HOST ? 8_000_000 : 2_000_000;
  return {
    name: "queue_metrics",
    shardCount: env.QUEUE_METRICS_STREAM_SHARD_COUNT,
    consumerGroup: "queue_metrics_cg",
    maxLen: env.QUEUE_METRICS_COUNTER_STREAM_MAXLEN ?? defaultMaxLen,
  };
}

// Dedicated client for the admin read/write/probe surface — works regardless of whether
// this instance runs the emitter/consumer. keyPrefix unset to match the raw control keys.
function adminRedis(): Redis {
  return singleton("queueMetricsAdminRedis", () =>
    createRedisClient(
      { ...runQueueRedisOptions(), keyPrefix: undefined },
      { onError: (error) => logger.error("queue metrics admin redis error", { error }) }
    )
  );
}

function metricsAdminRedis(): Redis {
  return singleton("queueMetricsCounterAdminRedis", () =>
    createRedisClient(
      { ...metricsRedisOptions(), keyPrefix: undefined },
      { onError: (error) => logger.error("queue metrics counter admin redis error", { error }) }
    )
  );
}

export type QueueMetricsControls = {
  enabled: boolean;
  enabledKeySet: boolean;
  sampleRate: number;
  sampleRateKeySet: boolean;
  sampleRateDefault: number;
};

export async function readQueueMetricsControls(): Promise<QueueMetricsControls> {
  const [enabledRaw, rateRaw] = (await adminRedis().mget(FLAG_KEY, SAMPLE_RATE_KEY)) as (
    | string
    | null
  )[];
  const sampleRateDefault = env.QUEUE_METRICS_GAUGE_SAMPLE_RATE;
  const parsed = rateRaw == null ? Number.NaN : Number(rateRaw);
  return {
    enabled: enabledRaw != null && TRUTHY.has(enabledRaw.trim().toLowerCase()),
    enabledKeySet: enabledRaw != null,
    sampleRate: Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : sampleRateDefault,
    sampleRateKeySet: rateRaw != null,
    sampleRateDefault,
  };
}

export async function writeQueueMetricsControls(update: {
  enabled?: boolean;
  sampleRate?: number;
}): Promise<void> {
  const client = adminRedis();
  const ops: Promise<unknown>[] = [];
  if (update.enabled !== undefined) {
    ops.push(client.set(FLAG_KEY, update.enabled ? "1" : "0"));
  }
  if (update.sampleRate !== undefined) {
    ops.push(client.set(SAMPLE_RATE_KEY, String(Math.min(1, Math.max(0, update.sampleRate)))));
  }
  await Promise.all(ops);
}

export type LabeledShardState = ShardState & { stream: "queue_metrics" };

export async function probeQueueMetricsStreams(): Promise<LabeledShardState[]> {
  const def = metricsDefinition();
  const states = await probeShardStates(metricsAdminRedis(), allStreamKeys(def), def.consumerGroup);
  return states.map((s) => ({ ...s, stream: "queue_metrics" as const }));
}

/** Injected into the RunQueue when QUEUE_METRICS_EMIT_ENABLED=1; emits only while the flag is on. */
export function getQueueMetricsEmitter(): MetricsStreamEmitter {
  return singleton("queueMetricsEmitter", () => {
    // Control keys stay on the run-queue Redis (the admin surface + docs point there).
    const controlRedis = runQueueRedisOptions();
    const flag = new CachedRedisFlag({ redis: controlRedis, key: FLAG_KEY, cacheTtlMs: 10_000 });
    // Live-tunable (Redis key, 10s cache); the env value is the default when the key is unset.
    const gaugeSampleRate = new CachedRedisNumber({
      redis: controlRedis,
      key: SAMPLE_RATE_KEY,
      defaultValue: env.QUEUE_METRICS_GAUGE_SAMPLE_RATE,
      min: 0,
      max: 1,
      cacheTtlMs: 10_000,
    });
    return new MetricsStreamEmitter({
      redis: metricsRedisOptions(),
      definition: metricsDefinition(),
      flag,
      meter,
      gaugeSampleRate,
      counterOdometerTtlMs: env.QUEUE_METRICS_COUNTER_ODOMETER_TTL_SECONDS * 1000,
    });
  });
}

const queueNameLimiter = singleton(
  "queueMetricsQueueNameLimiter",
  () => new QueueNameLimiter(env.QUEUE_METRICS_MAX_QUEUE_NAMES_PER_ENV)
);

const concurrencyKeyLimiter = singleton(
  "queueMetricsConcurrencyKeyLimiter",
  () => new QueueNameLimiter(env.QUEUE_METRICS_MAX_CONCURRENCY_KEYS_PER_QUEUE, 50_000)
);

function mapEntry(entry: StreamEntry): QueueMetricsRawV1Input[] {
  return mapEntryToRows(entry, {
    queueNames: queueNameLimiter,
    concurrencyKeys: concurrencyKeyLimiter,
  });
}

function makeInsert(): (
  rows: QueueMetricsRawV1Input[],
  opts: { dedupToken: string }
) => Promise<void> {
  const ch: ClickHouse = getQueueMetricsClickhouseClient();
  const insertRaw = ch.queueMetrics.insertRaw;
  return async (rows, { dedupToken }) => {
    const [error] = await insertRaw(rows, {
      params: {
        clickhouse_settings: {
          insert_deduplication_token: dedupToken,
          async_insert: 0,
          // Propagate the token through the MV so a raw-deduped retry can't leave
          // queue_metrics_v1 short when the MV insert failed on the first attempt.
          deduplicate_blocks_in_dependent_materialized_views: 1,
        },
      },
    });
    if (error) throw error;
  };
}

function getQueueMetricsConsumers(): MetricsStreamConsumer<QueueMetricsRawV1Input>[] {
  return singleton("queueMetricsConsumers", () => {
    const insert = makeInsert();
    return [
      new MetricsStreamConsumer<QueueMetricsRawV1Input>({
        consumerName: `${os.hostname()}-${process.pid}`,
        batchSize: env.QUEUE_METRICS_CONSUMER_BATCH_SIZE,
        meter,
        mapEntry,
        insert,
        redis: metricsRedisOptions(),
        definition: metricsDefinition(),
      }),
    ];
  });
}

// Construct the emitter at boot (not lazily on the first enqueue) so its flag has warmed
// before any traffic — otherwise the first op after boot reads the default and is dropped.
export function initQueueMetricsEmitter(): void {
  if (env.QUEUE_METRICS_EMIT_ENABLED !== "1") return;
  getQueueMetricsEmitter();
}

declare global {
  // eslint-disable-next-line no-var
  var __queueMetricsConsumerRegistered__: boolean | undefined;
}

export function initQueueMetricsConsumer(): void {
  if (env.QUEUE_METRICS_CONSUMER_ENABLED !== "1") return;
  if (global.__queueMetricsConsumerRegistered__) return;
  global.__queueMetricsConsumerRegistered__ = true;

  const consumers = getQueueMetricsConsumers();
  const stop = () =>
    Promise.all(consumers.map((c) => c.stop())).catch((error) =>
      logger.error("queue metrics consumer stop failed", { error })
    );
  signalsEmitter.on("SIGTERM", stop);
  signalsEmitter.on("SIGINT", stop);

  Promise.all(consumers.map((c) => c.start()))
    .then(() => logger.info("Queue metrics consumer started"))
    .catch((error) => logger.error("queue metrics consumers failed to start", { error }));
}
