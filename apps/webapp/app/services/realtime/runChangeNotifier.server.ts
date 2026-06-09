import { createRedisClient, RedisClient, RedisWithClusterOptions } from "~/redis.server";
import { logger } from "../logger.server";

export const CHANGE_RECORD_VERSION = 1;

/**
 * A run-change fact, published once to the run's environment channel. Self-describing:
 *  - `envId` routes it to its channel (mandatory).
 *  - `tags` / `batchId` let a tag/batch feed decide membership LOCALLY, without a
 *    ClickHouse re-resolve. `tags` present (even `[]`) marks a "full" record; `tags`
 *    absent marks a "partial" record (envId+runId only) that a tag feed must hydrate to
 *    classify. `batchId` present only when the run is in a batch.
 *  - `runId` lets a single-run feed match; `createdAtMs` lets a tag feed apply its
 *    createdAt floor locally; `updatedAtMs`/`status` are hints.
 * Row state (payload/output/...) is never on the wire — it's refetched from Postgres.
 */
export type ChangeRecord = {
  v: number;
  runId: string;
  envId: string;
  tags?: string[];
  batchId?: string | null;
  createdAtMs?: number;
  updatedAtMs?: number;
  status?: string;
};

/** What a publish site provides; the notifier stamps the version. */
export type ChangeRecordInput = Omit<ChangeRecord, "v">;

export function encodeChangeRecord(record: ChangeRecord): string {
  return JSON.stringify(record);
}

/** Decode a wire message into a ChangeRecord. Tolerant of a bare runId (no membership
 * data) so a malformed/legacy frame degrades to a partial record (hydrate-to-classify)
 * rather than throwing. */
export function decodeChangeRecord(message: string): ChangeRecord {
  if (message.length === 0 || message[0] !== "{") {
    return { v: 0, runId: message, envId: "" };
  }
  try {
    const parsed = JSON.parse(message) as Partial<ChangeRecord>;
    if (parsed && typeof parsed.runId === "string") {
      return {
        v: parsed.v ?? 0,
        runId: parsed.runId,
        envId: parsed.envId ?? "",
        tags: parsed.tags,
        batchId: parsed.batchId,
        createdAtMs: parsed.createdAtMs,
        updatedAtMs: parsed.updatedAtMs,
        status: parsed.status,
      };
    }
  } catch {
    // fall through to the bare-runId fallback
  }
  return { v: 0, runId: message, envId: "" };
}

export type RunChangeNotifierOptions = {
  redis: RedisWithClusterOptions;
  /** Channel name prefix; the envId is appended inside a hash-tag for slot locality. */
  channelPrefix?: string;
  connectionName?: string;
  /**
   * Leading-edge throttle (ms) for the per-env channel: deliver the first wake
   * immediately, then at most one more per window while changes keep arriving. Bounds the
   * wake rate per env regardless of run throughput. Defaults to 100ms. 0 disables it.
   */
  envWakeCoalesceWindowMs?: number;
  /**
   * Use Redis sharded pub/sub (SSUBSCRIBE/SPUBLISH) instead of classic pub/sub. Only
   * valid against a Redis Cluster (channels are hash-tagged by envId, so each lands on one
   * shard) and requires the client built with `clusterOptions.shardedSubscribers: true`.
   * Classic PUBLISH in a cluster broadcasts to every node, so sharded pub/sub is what
   * actually distributes the load. Defaults to false (classic, for single-node / local).
   */
  shardedPubSub?: boolean;
};

const DEFAULT_CHANNEL_PREFIX = "realtime:";
const DEFAULT_ENV_WAKE_COALESCE_WINDOW_MS = 100;

/**
 * RunChangeNotifier — carries "run X changed" facts from write sites to the realtime
 * feed over ONE per-environment channel.
 *
 * Design constraints baked in here:
 *  - ONE channel type, `<prefix>env:{<envId>}`. A change is one fact published once; who
 *    cares about it is a predicate evaluated by the consumer (the EnvChangeRouter), not a
 *    second channel. Single-run, tag, and batch feeds all read this one stream.
 *  - Minimal wire data (a self-describing `ChangeRecord` of small keys), never row
 *    columns. Row state is always refetched from Postgres.
 *  - ONE shared, multiplexed subscriber connection per process with a refcounted
 *    `Map<channel, Set<listener>>`. The RunQueue pattern, deliberately NOT the
 *    per-subscribe-connection pattern of ZodPubSub/tracePubSub (which would exhaust
 *    ElastiCache `maxclients`).
 *  - Connections are created lazily: a process that never publishes or subscribes (the
 *    default, flag-off state) opens no Redis connections at all.
 *  - `publish` is fire-and-forget and never throws; a dropped publish only costs latency
 *    because the consumer has a timeout backstop.
 *
 * Channels are hash-tagged (`<prefix>env:{<envId>}`) so an env's traffic lands on one
 * cluster slot. With `shardedPubSub` (cluster only) the feed uses SSUBSCRIBE/SPUBLISH so
 * each env's traffic stays on one shard rather than broadcasting cluster-wide.
 */
export class RunChangeNotifier {
  #publisher: RedisClient | undefined;
  #subscriber: RedisClient | undefined;
  readonly #listeners = new Map<string, Set<(records: ChangeRecord[]) => void>>();
  /**
   * Per-channel accumulator of records since the last delivery, deduped by runId. A
   * coalesced env window collapses many publishes into one wake; this holds the batch so
   * the wake carries every run that moved, not just the last one (latest record per run
   * wins, keeping the freshest keys).
   */
  readonly #pending = new Map<string, Map<string, ChangeRecord>>();
  readonly #channelPrefix: string;
  readonly #connectionName: string;
  readonly #coalesceWindowMs: number;
  /** When true, use sharded pub/sub (SSUBSCRIBE/SPUBLISH/smessage) — see options. */
  readonly #sharded: boolean;
  /** Active coalescing windows per channel. */
  readonly #coalesceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Channels that received a message while their window was open (need a trailing wake). */
  readonly #coalesceDirty = new Set<string>();

  constructor(private readonly options: RunChangeNotifierOptions) {
    this.#channelPrefix = options.channelPrefix ?? DEFAULT_CHANNEL_PREFIX;
    this.#connectionName = options.connectionName ?? "trigger:realtime:run-change-notifier";
    this.#coalesceWindowMs = options.envWakeCoalesceWindowMs ?? DEFAULT_ENV_WAKE_COALESCE_WINDOW_MS;
    this.#sharded = options.shardedPubSub ?? false;
  }

  /**
   * Fire-and-forget publish of a run-changed fact to the run's environment channel. Never
   * throws. The notifier stamps the record version.
   */
  publish(input: ChangeRecordInput): void {
    const record: ChangeRecord = { v: CHANGE_RECORD_VERSION, ...input };
    this.#publishToChannel(this.#channelForEnv(record.envId), encodeChangeRecord(record));
  }

  /** Fire-and-forget publish of many run-changed facts. Never throws. */
  publishMany(inputs: ChangeRecordInput[]): void {
    for (const input of inputs) {
      this.publish(input);
    }
  }

  #publishToChannel(channel: string, payload: string): void {
    try {
      const publisher = this.#ensurePublisher();
      // Sharded pub/sub (SPUBLISH) routes to the channel's slot owner; classic PUBLISH
      // broadcasts cluster-wide. The channel is hash-tagged by envId.
      const result = this.#sharded
        ? publisher.spublish(channel, payload)
        : publisher.publish(channel, payload);
      if (typeof (result as Promise<number>)?.catch === "function") {
        (result as Promise<number>).catch((error) => {
          logger.error("[runChangeNotifier] Failed to publish run-changed notification", {
            error,
            channel,
          });
        });
      }
    } catch (error) {
      logger.error("[runChangeNotifier] Failed to publish run-changed notification", {
        error,
        channel,
      });
    }
  }

  /**
   * Subscribe (persistently) to an environment's run-change stream. `onBatch` is invoked
   * with the coalesced batch of records on every wake until the returned unsubscribe is
   * called. Refcounted over the shared subscriber: the first listener for an env issues
   * SUBSCRIBE, the last one UNSUBSCRIBE.
   */
  subscribeToEnv(environmentId: string, onBatch: (records: ChangeRecord[]) => void): () => void {
    const channel = this.#channelForEnv(environmentId);
    const subscriber = this.#ensureSubscriber();

    let listeners = this.#listeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(channel, listeners);
      this.#subscribeChannel(subscriber, channel).catch((error) => {
        logger.error("[runChangeNotifier] Failed to subscribe to run-change channel", {
          error,
          channel,
        });
      });
    }
    listeners.add(onBatch);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) {
        return;
      }
      unsubscribed = true;

      const current = this.#listeners.get(channel);
      if (!current) {
        return;
      }
      current.delete(onBatch);
      if (current.size === 0) {
        // Drop the channel from the map only AFTER Redis confirms UNSUBSCRIBE, and only if
        // no new listener re-subscribed while it was in flight. The map entry's existence
        // mirrors "subscribed (or subscribe in flight) in Redis", so the subscribe path
        // safely reuses it without a duplicate SUBSCRIBE.
        this.#unsubscribeChannel(subscriber, channel)
          .then(() => {
            const latest = this.#listeners.get(channel);
            if (!latest) {
              return;
            }
            if (latest.size === 0) {
              this.#listeners.delete(channel);
            } else {
              // A listener arrived during the in-flight UNSUBSCRIBE; the channel is now
              // unsubscribed in Redis but has live listeners. Re-subscribe so they keep
              // receiving messages (the long-poll backstop covers the gap).
              this.#subscribeChannel(subscriber, channel).catch((error) => {
                logger.error("[runChangeNotifier] Failed to re-subscribe to run-change channel", {
                  error,
                  channel,
                });
              });
            }
          })
          .catch((error) => {
            // UNSUBSCRIBE failed: the channel is likely still subscribed in Redis. Keep the
            // (empty) map entry so a future subscriber reuses it without a duplicate
            // SUBSCRIBE and #onMessage stays consistent with Redis state.
            logger.error("[runChangeNotifier] Failed to unsubscribe from run-change channel", {
              error,
              channel,
            });
          });
      }
    };
  }

  /** Number of distinct env channels currently subscribed (for metrics). */
  get activeSubscriptionCount(): number {
    return this.#listeners.size;
  }

  async quit(): Promise<void> {
    for (const timer of this.#coalesceTimers.values()) {
      clearTimeout(timer);
    }
    this.#coalesceTimers.clear();
    this.#coalesceDirty.clear();
    this.#pending.clear();
    await Promise.allSettled([this.#subscriber?.quit(), this.#publisher?.quit()]);
    this.#subscriber = undefined;
    this.#publisher = undefined;
    this.#listeners.clear();
  }

  #ensurePublisher(): RedisClient {
    if (!this.#publisher) {
      this.#publisher = createRedisClient(`${this.#connectionName}:pub`, this.options.redis);
    }
    return this.#publisher;
  }

  #ensureSubscriber(): RedisClient {
    if (!this.#subscriber) {
      const subscriber = createRedisClient(`${this.#connectionName}:sub`, this.options.redis);
      const onMessage = (channel: string, message: string) => this.#onMessage(channel, message);
      // Classic pub/sub delivers "message"; sharded pub/sub delivers "smessage". Register
      // both so the delivery path is identical regardless of mode.
      subscriber.on("message", onMessage);
      subscriber.on("smessage", onMessage);
      this.#subscriber = subscriber;
    }
    return this.#subscriber;
  }

  /** SUBSCRIBE (classic) vs SSUBSCRIBE (sharded, cluster-only). */
  #subscribeChannel(subscriber: RedisClient, channel: string): Promise<unknown> {
    return this.#sharded ? subscriber.ssubscribe(channel) : subscriber.subscribe(channel);
  }

  /** UNSUBSCRIBE (classic) vs SUNSUBSCRIBE (sharded, cluster-only). */
  #unsubscribeChannel(subscriber: RedisClient, channel: string): Promise<unknown> {
    return this.#sharded ? subscriber.sunsubscribe(channel) : subscriber.unsubscribe(channel);
  }

  #onMessage(channel: string, message: string) {
    // Accumulate the decoded record (deduped by runId) before delivering, so a coalesced
    // wake carries every run that moved during the window.
    this.#addPending(channel, decodeChangeRecord(message));

    if (this.#coalesceWindowMs > 0) {
      this.#deliverCoalesced(channel);
      return;
    }
    this.#deliver(channel);
  }

  /** Accumulate a record into the channel's pending batch, deduped by runId (a later
   * record for the same run replaces the earlier one, keeping the freshest keys). */
  #addPending(channel: string, record: ChangeRecord) {
    let batch = this.#pending.get(channel);
    if (!batch) {
      batch = new Map();
      this.#pending.set(channel, batch);
    }
    batch.set(record.runId, record);
  }

  #deliver(channel: string) {
    // Drain the accumulated batch (and clear it) so listeners woken now get every run that
    // changed since the last delivery, and a later message starts a fresh batch.
    const batchMap = this.#pending.get(channel);
    const batch = batchMap ? [...batchMap.values()] : [];
    this.#pending.delete(channel);

    const listeners = this.#listeners.get(channel);
    if (!listeners || batch.length === 0) {
      return;
    }
    for (const onBatch of [...listeners]) {
      onBatch(batch);
    }
  }

  /**
   * Leading-edge throttle: deliver the first wake immediately, then suppress further wakes
   * for the window, delivering one trailing wake if any messages arrived during it (and
   * re-opening while activity continues). Caps the wake rate per env to ~1/window no
   * matter how fast runs change. Lossless: the batch accumulates across the window.
   */
  #deliverCoalesced(channel: string) {
    if (this.#coalesceTimers.has(channel)) {
      this.#coalesceDirty.add(channel);
      return;
    }
    this.#deliver(channel);
    this.#openCoalesceWindow(channel);
  }

  #openCoalesceWindow(channel: string) {
    const timer = setTimeout(() => {
      this.#coalesceTimers.delete(channel);
      if (this.#coalesceDirty.delete(channel)) {
        this.#deliver(channel);
        this.#openCoalesceWindow(channel);
      }
    }, this.#coalesceWindowMs);
    // Don't let a pending coalescing window hold the process open at shutdown.
    timer.unref?.();
    this.#coalesceTimers.set(channel, timer);
  }

  // Hash-tagged (`...{<envId>}`) so all of an env's traffic maps to one cluster slot (one
  // shard) under sharded pub/sub.
  #channelForEnv(environmentId: string): string {
    return `${this.#channelPrefix}env:{${environmentId}}`;
  }
}
