import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import {
  getMeter,
  type Counter,
  type Histogram,
  type Meter,
  type ObservableGauge,
  ValueType,
} from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { dedupTokenFromEntryIds } from "./idempotency.js";
import { allStreamKeys, type MetricDefinition, type StreamEntry } from "./types.js";

export type MetricsStreamConsumerOptions<TRow> = {
  redis: RedisOptions;
  definition: MetricDefinition;
  /** Unique per process; distinct replicas MUST use distinct names (PEL ownership). */
  consumerName: string;
  /** Map a stream entry to a row, or null to drop it (still acked). */
  mapEntry: (entry: StreamEntry) => TRow | TRow[] | null;
  /** Insert a batch. Must be idempotent w.r.t. dedupToken; throw to retry the batch. */
  insert: (rows: TRow[], opts: { dedupToken: string }) => Promise<void>;
  batchSize?: number;
  blockMs?: number;
  claimIdleMs?: number;
  /** How often to scan for stale pending entries (XAUTOCLAIM); not every poll. */
  reclaimIntervalMs?: number;
  errorBackoffMs?: number;
  logger?: Logger;
  meter?: Meter;
};

type RawEntry = [id: string, fields: string[]];
type RawStream = [key: string, entries: RawEntry[]];

/** Per-shard stream health, surfaced as observable gauges and usable directly in tests.
 * `lag: null` means Redis could not compute it (entries trimmed past the group's read
 * position) — treat as an alert, NOT as zero: it coincides with data loss. */
export type ShardState = { shard: number; depth: number; lag: number | null; pending: number };

function parseFields(flat: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out[flat[i]!] = flat[i + 1]!;
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reads a sharded metrics stream via a consumer group, inserting each stream's poll-batch
 * as its own dedup block (so an XAUTOCLAIM-reclaimed batch re-forms the same id set and
 * token), acking only after a successful insert. Sequential read/insert/ack per process.
 */
export class MetricsStreamConsumer<TRow> {
  private readonly redis: Redis;
  private readonly probeRedis: Redis;
  private readonly def: MetricDefinition;
  private readonly keys: string[];
  private readonly consumerName: string;
  private readonly batchSize: number;
  private readonly blockMs: number;
  private readonly claimIdleMs: number;
  private readonly reclaimIntervalMs: number;
  private lastReclaimAt = 0;
  private readonly errorBackoffMs: number;
  private readonly logger: Logger;
  private readonly mapEntry: (entry: StreamEntry) => TRow | TRow[] | null;
  private readonly insert: (rows: TRow[], opts: { dedupToken: string }) => Promise<void>;

  private readonly meter: Meter;
  private readonly entriesCounter: Counter;
  private readonly rowsCounter: Counter;
  private readonly insertErrorCounter: Counter;
  private readonly insertDuration: Histogram;
  private readonly observables: ObservableGauge[];
  private readonly batchCallback: Parameters<Meter["addBatchObservableCallback"]>[0];

  private running = false;
  private loopPromise?: Promise<void>;

  constructor(options: MetricsStreamConsumerOptions<TRow>) {
    this.logger = options.logger ?? new Logger("MetricsStreamConsumer", "info");
    const redisConfig = { ...options.redis, keyPrefix: undefined };
    this.redis = createRedisClient(redisConfig, {
      onError: (error) => this.logger.error("consumer redis error", { error }),
    });
    // Separate client so the observable-gauge probes never queue behind the blocking XREADGROUP.
    this.probeRedis = createRedisClient(redisConfig, {
      onError: (error) => this.logger.error("consumer probe redis error", { error }),
    });
    this.def = options.definition;
    this.keys = allStreamKeys(options.definition);
    this.consumerName = options.consumerName;
    this.batchSize = options.batchSize ?? 1000;
    this.blockMs = options.blockMs ?? 1000;
    this.claimIdleMs = options.claimIdleMs ?? 60_000;
    this.reclaimIntervalMs = options.reclaimIntervalMs ?? 15_000;
    this.errorBackoffMs = options.errorBackoffMs ?? 1000;
    this.mapEntry = options.mapEntry;
    this.insert = options.insert;

    this.meter = options.meter ?? getMeter("metrics-pipeline");
    this.entriesCounter = this.meter.createCounter("queue_metrics.consumer.entries", {
      description: "Stream entries read (attr source=new|reclaimed)",
      valueType: ValueType.INT,
    });
    this.rowsCounter = this.meter.createCounter("queue_metrics.consumer.rows_inserted", {
      description: "Rows inserted into the sink",
      valueType: ValueType.INT,
    });
    this.insertErrorCounter = this.meter.createCounter("queue_metrics.consumer.insert_errors", {
      description: "Failed inserts (batch left pending for retry)",
      valueType: ValueType.INT,
    });
    this.insertDuration = this.meter.createHistogram("queue_metrics.consumer.insert_duration", {
      description: "Sink insert latency",
      unit: "ms",
      valueType: ValueType.INT,
    });

    const depthGauge = this.meter.createObservableGauge("queue_metrics.consumer.stream_depth", {
      description: "Entries currently in each shard stream (approaches MAXLEN => trimming)",
      valueType: ValueType.INT,
    });
    const lagGauge = this.meter.createObservableGauge("queue_metrics.consumer.group_lag", {
      description: "Entries not yet delivered to the consumer group (consumer falling behind)",
      valueType: ValueType.INT,
    });
    const pendingGauge = this.meter.createObservableGauge("queue_metrics.consumer.pending", {
      description: "Unacked (in-flight or stuck) entries in the group PEL",
      valueType: ValueType.INT,
    });
    const lagUnknownGauge = this.meter.createObservableGauge("queue_metrics.consumer.lag_unknown", {
      description:
        "1 when Redis cannot compute group lag (entries trimmed => data loss); alert on this",
      valueType: ValueType.INT,
    });
    this.observables = [depthGauge, lagGauge, pendingGauge, lagUnknownGauge];
    this.batchCallback = async (result) => {
      const states = await this.streamState();
      for (const s of states) {
        const attrs = { stream: this.def.name, shard: String(s.shard) };
        result.observe(depthGauge, s.depth, attrs);
        if (s.lag !== null) result.observe(lagGauge, s.lag, attrs);
        result.observe(lagUnknownGauge, s.lag === null ? 1 : 0, attrs);
        result.observe(pendingGauge, s.pending, attrs);
      }
    };
    this.meter.addBatchObservableCallback(this.batchCallback, this.observables);
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.ensureGroups();
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.meter.removeBatchObservableCallback(this.batchCallback, this.observables);
    await this.loopPromise?.catch(() => {});
    await Promise.all([this.redis.quit().catch(() => {}), this.probeRedis.quit().catch(() => {})]);
  }

  private async ensureGroups(): Promise<void> {
    for (const key of this.keys) {
      try {
        // "0" (not "$"): a brand-new stream's group must not skip entries emitted
        // between emitter boot and the first consumer's group creation.
        await this.redis.xgroup("CREATE", key, this.def.consumerGroup, "0", "MKSTREAM");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("BUSYGROUP")) throw error;
      }
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (Date.now() - this.lastReclaimAt >= this.reclaimIntervalMs) {
          this.lastReclaimAt = Date.now();
          await this.reclaimStale();
        }
        await this.readNew();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Self-heal a missing group (stream trimmed to nothing / deleted / Redis flushed):
        // recreate it rather than wedging the loop on NOGROUP forever.
        if (message.includes("NOGROUP")) {
          this.logger.warn("consumer group missing; recreating", { error });
          await this.ensureGroups().catch(() => {});
        } else {
          this.logger.error("consumer loop iteration failed", { error });
        }
        await sleep(this.errorBackoffMs);
      }
    }
  }

  private async readNew(): Promise<number> {
    const ids = this.keys.map(() => ">");
    const response = (await this.redis.xreadgroup(
      "GROUP",
      this.def.consumerGroup,
      this.consumerName,
      "COUNT",
      this.batchSize,
      "BLOCK",
      this.blockMs,
      "STREAMS",
      ...this.keys,
      ...ids
    )) as RawStream[] | null;

    if (!response) return 0;
    return this.processStreams(response, "new");
  }

  private async reclaimStale(): Promise<void> {
    for (const key of this.keys) {
      const result = (await this.redis.xautoclaim(
        key,
        this.def.consumerGroup,
        this.consumerName,
        this.claimIdleMs,
        "0",
        "COUNT",
        this.batchSize
      )) as [string, RawEntry[], string[]] | null;

      const entries = result?.[1] ?? [];
      if (entries.length === 0) continue;
      await this.processStreams([[key, entries]], "reclaimed");
    }
  }

  // One insert (dedup block) and XACK per stream, so a reclaimed batch re-forms the
  // original per-stream id set and token. On insert failure that stream's entries stay
  // pending for a later XAUTOCLAIM; other streams still progress.
  private async processStreams(streams: RawStream[], source: "new" | "reclaimed"): Promise<number> {
    let processed = 0;
    let firstError: unknown;

    for (const [key, entries] of streams) {
      if (entries.length === 0) continue;
      const keyIds: string[] = [];
      const rows: TRow[] = [];
      for (const [id, flat] of entries) {
        keyIds.push(id);
        const mapped = this.mapEntry({ id, fields: parseFields(flat) });
        if (Array.isArray(mapped)) rows.push(...mapped);
        else if (mapped !== null) rows.push(mapped);
      }
      this.entriesCounter.add(keyIds.length, { source });

      if (rows.length > 0) {
        const startedAt = Date.now();
        try {
          await this.insert(rows, { dedupToken: dedupTokenFromEntryIds(keyIds, key) });
        } catch (error) {
          this.insertErrorCounter.add(1);
          firstError ??= error;
          continue;
        } finally {
          this.insertDuration.record(Date.now() - startedAt);
        }
        this.rowsCounter.add(rows.length);
      }

      await this.redis.xack(key, this.def.consumerGroup, ...keyIds);
      processed += keyIds.length;
    }

    if (firstError !== undefined) throw firstError;
    return processed;
  }

  /** Per-shard depth (XLEN), group lag, and pending — the consumer-health signals. */
  async streamState(): Promise<ShardState[]> {
    return probeShardStates(this.probeRedis, this.keys, this.def.consumerGroup);
  }

  /** All shard stream keys this consumer reads (for diagnostics/tests). */
  streamKeys(): string[] {
    return this.keys.slice();
  }
}

/**
 * Per-shard depth/lag/pending for a metric stream — usable without a running consumer
 * (e.g. from an admin route). `redis` should have keyPrefix unset, matching the stream keys.
 */
export async function probeShardStates(
  redis: Redis,
  keys: string[],
  consumerGroup: string
): Promise<ShardState[]> {
  const out: ShardState[] = [];
  for (let shard = 0; shard < keys.length; shard++) {
    const key = keys[shard]!;
    const depth = Number(await redis.xlen(key)) || 0;
    // lag defaults to null (unknown) and only becomes a number when the group is found and
    // Redis reports one: a nil lag (or a missing group on an existing stream) means we can't
    // compute it, e.g. entries were trimmed past the group's read position (data loss).
    let lag: number | null = null;
    let pending = 0;
    try {
      const groups = (await redis.call("XINFO", "GROUPS", key)) as unknown[];
      for (const raw of groups) {
        const info = flatToMap(raw as unknown[]);
        if (info.name === consumerGroup) {
          const rawLag = info.lag;
          lag = rawLag == null ? null : Number(rawLag);
          if (lag !== null && !Number.isFinite(lag)) lag = null;
          pending = Number(info.pending) || 0;
        }
      }
    } catch {
      // Stream/group may not exist yet; treat as zero.
    }
    out.push({ shard, depth, lag, pending });
  }
  return out;
}

function flatToMap(flat: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out[String(flat[i])] = flat[i + 1];
  }
  return out;
}
