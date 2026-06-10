import { createRedisClient, RedisClient, RedisWithClusterOptions } from "~/redis.server";
import { logger } from "../logger.server";

export const CHANGE_RECORD_VERSION = 1;

/**
 * A self-describing run-change fact published once to the run's environment channel; row state is
 * never on the wire. `tags` present (even `[]`) marks a "full" record a feed can classify locally;
 * `tags` absent marks a "partial" record (envId+runId only) a tag feed must hydrate to classify.
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

/** Decode a wire message into a ChangeRecord; a bare/malformed frame degrades to a partial record rather than throwing. */
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
  /** Leading-edge throttle (ms) for the per-env channel, bounding the wake rate per env. Defaults to 100ms; 0 disables. */
  envWakeCoalesceWindowMs?: number;
  /** Use Redis sharded pub/sub (SSUBSCRIBE/SPUBLISH); cluster-only and requires `clusterOptions.shardedSubscribers`. Defaults to false (classic). */
  shardedPubSub?: boolean;
};

const DEFAULT_CHANNEL_PREFIX = "realtime:";
const DEFAULT_ENV_WAKE_COALESCE_WINDOW_MS = 100;

/**
 * RunChangeNotifier — carries "run X changed" facts from write sites to the realtime feeds over ONE
 * per-environment channel (`<prefix>env:{<envId>}`, hash-tagged so an env stays on one cluster slot).
 * Uses one shared multiplexed subscriber per process (refcounted), created lazily, and a fire-and-forget
 * `publish` that never throws — a dropped publish only costs latency because the consumer has a backstop.
 */
export class RunChangeNotifier {
  #publisher: RedisClient | undefined;
  #subscriber: RedisClient | undefined;
  readonly #listeners = new Map<string, Set<(records: ChangeRecord[]) => void>>();
  /** Per-channel accumulator of records since the last delivery, deduped by runId (latest per run wins), so a coalesced wake carries every run that moved. */
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

  /** Fire-and-forget publish of a run-changed fact to the run's environment channel; never throws. */
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

  /** Subscribe to an env's run-change stream; refcounted over the shared subscriber (first listener SUBSCRIBEs, last UNSUBSCRIBEs). */
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
        // Drop the channel from the map only after Redis confirms UNSUBSCRIBE and no new listener re-subscribed in the meantime.
        this.#unsubscribeChannel(subscriber, channel)
          .then(() => {
            const latest = this.#listeners.get(channel);
            if (!latest) {
              return;
            }
            if (latest.size === 0) {
              this.#listeners.delete(channel);
            } else {
              // A listener arrived during the in-flight UNSUBSCRIBE; re-subscribe so it keeps receiving (the backstop covers the gap).
              this.#subscribeChannel(subscriber, channel).catch((error) => {
                logger.error("[runChangeNotifier] Failed to re-subscribe to run-change channel", {
                  error,
                  channel,
                });
              });
            }
          })
          .catch((error) => {
            // UNSUBSCRIBE failed (likely still subscribed in Redis): keep the empty map entry so a future subscriber reuses it.
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

  /** Leading-edge throttle capping the wake rate to ~1/window: deliver the first wake immediately, then one trailing wake per window while activity continues. Lossless. */
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
