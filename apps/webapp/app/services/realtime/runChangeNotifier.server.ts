import { createRedisClient, RedisClient, RedisWithClusterOptions } from "~/redis.server";
import { logger } from "../logger.server";

export type RunChangeInput = {
  runId: string;
  /**
   * Optional. The single-run channel is keyed by runId alone; environmentId is
   * carried for the per-env channels and metrics. Write sites that don't
   * have it cheaply in scope may omit it.
   */
  environmentId?: string;
  /** Optional monotonic hint; not required since consumers always refetch. */
  version?: number;
};

export type RunChangeNotifierOptions = {
  redis: RedisWithClusterOptions;
  /** Channel name prefix; the runId is appended inside a hash-tag for slot locality. */
  channelPrefix?: string;
  connectionName?: string;
  /**
   * Leading-edge throttle (ms) for the high-volume per-env channel: deliver the
   * first wake immediately, then at most one more per window while changes keep
   * arriving. Bounds the feed-wake rate per env regardless of run throughput.
   * Defaults to 100ms. 0 disables coalescing (wake on every message).
   */
  envWakeCoalesceWindowMs?: number;
  /**
   * Use Redis sharded pub/sub (SSUBSCRIBE/SPUBLISH) instead of classic pub/sub.
   * Only valid against a Redis Cluster (the channels are hash-tagged by run/env id,
   * so each lands on one shard) and requires the client to be built with
   * `clusterOptions.shardedSubscribers: true`. Classic PUBLISH in a cluster
   * broadcasts to every node, so sharded pub/sub is what actually distributes the
   * load. Defaults to false (classic pub/sub, for single-node / local).
   */
  shardedPubSub?: boolean;
};

export type RunChangeSubscription = {
  /** Resolves the next time a change is published for the subscribed run. */
  changed: Promise<void>;
  unsubscribe: () => void;
};

const DEFAULT_CHANNEL_PREFIX = "realtime:";
const DEFAULT_ENV_WAKE_COALESCE_WINDOW_MS = 100;

/**
 * RunChangeNotifier — the single, encapsulated module that carries "run X changed"
 * signals from write sites to the realtime feed.
 *
 * Design constraints baked in here:
 *  - IDs only on the wire, never row data. Consumers refetch from Postgres.
 *  - ONE shared, multiplexed subscriber connection per process with a refcounted
 *    `Map<channel, Set<listener>>` (per-run + per-env channels). The RunQueue
 *    pattern, deliberately NOT
 *    the per-subscribe-connection pattern of ZodPubSub/tracePubSub (which would
 *    exhaust ElastiCache `maxclients`).
 *  - Connections are created lazily: a process that never publishes or subscribes
 *    (the default, flag-off state) opens no Redis connections at all.
 *  - `publish` is fire-and-forget and never throws; a dropped publish only costs
 *    latency because the consumer has a timeout backstop.
 *
 * Channels are hash-tagged (`<prefix>{<runId>}` / `<prefix>env:{<envId>}`) so they
 * land on a single cluster slot. With `shardedPubSub` (cluster only) the feed uses
 * SSUBSCRIBE/SPUBLISH so each run/env's traffic stays on one shard rather than
 * broadcasting cluster-wide; classic pub/sub is used single-node.
 */
export class RunChangeNotifier {
  #publisher: RedisClient | undefined;
  #subscriber: RedisClient | undefined;
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #channelPrefix: string;
  readonly #connectionName: string;
  readonly #coalesceWindowMs: number;
  /** When true, use sharded pub/sub (SSUBSCRIBE/SPUBLISH/smessage) — see options. */
  readonly #sharded: boolean;
  /** Active coalescing windows per channel (env channels only). */
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
   * Fire-and-forget publish of a run-changed signal. Never throws. Publishes to
   * the per-run channel (single-run feed) and, when environmentId is known, the
   * per-env channel (tag/list feed). Payload is the runId so env consumers can
   * tell which run moved. IDs only, never row data.
   */
  publish(input: RunChangeInput): void {
    this.#publishToChannel(this.#channelForRun(input.runId), input.runId);
    if (input.environmentId) {
      this.#publishToChannel(this.#channelForEnv(input.environmentId), input.runId);
    }
  }

  #publishToChannel(channel: string, payload: string): void {
    try {
      const publisher = this.#ensurePublisher();
      // Sharded pub/sub (SPUBLISH) routes to the channel's slot owner; classic
      // PUBLISH broadcasts cluster-wide. The channel is hash-tagged by run/env id.
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

  /** Fire-and-forget publish of many run-changed signals. Never throws. */
  publishMany(inputs: RunChangeInput[]): void {
    for (const input of inputs) {
      this.publish(input);
    }
  }

  /**
   * Subscribe to the next change for a single run (single-run feed).
   */
  subscribeToRunChanges(runId: string): RunChangeSubscription {
    return this.#subscribe(this.#channelForRun(runId));
  }

  /**
   * Subscribe to the next change of ANY run in an environment (tag/list feed).
   * The consumer re-resolves its filter on each wake.
   */
  subscribeToEnvChanges(environmentId: string): RunChangeSubscription {
    return this.#subscribe(this.#channelForEnv(environmentId));
  }

  /**
   * Refcounted subscribe over the shared subscriber, keyed by the full channel:
   * the first listener for a channel issues SUBSCRIBE, the last one UNSUBSCRIBE.
   */
  #subscribe(channel: string): RunChangeSubscription {
    const subscriber = this.#ensureSubscriber();

    let resolveChanged: () => void = () => {};
    const changed = new Promise<void>((resolve) => {
      resolveChanged = resolve;
    });

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
    listeners.add(resolveChanged);

    let unsubscribed = false;
    const unsubscribe = () => {
      if (unsubscribed) {
        return;
      }
      unsubscribed = true;

      const current = this.#listeners.get(channel);
      if (!current) {
        return;
      }
      current.delete(resolveChanged);
      if (current.size === 0) {
        // Drop the channel from the map only AFTER Redis confirms UNSUBSCRIBE, and
        // only if no new listener re-subscribed while it was in flight. The map
        // entry's existence mirrors "subscribed (or subscribe in flight) in Redis",
        // so the subscribe path safely reuses it without a duplicate SUBSCRIBE.
        this.#unsubscribeChannel(subscriber, channel)
          .then(() => {
            const latest = this.#listeners.get(channel);
            if (!latest) {
              return;
            }
            if (latest.size === 0) {
              this.#listeners.delete(channel);
            } else {
              // A listener arrived during the in-flight UNSUBSCRIBE; the channel is
              // now unsubscribed in Redis but has live waiters. Re-subscribe so they
              // still receive messages (the long-poll backstop covers the gap).
              this.#subscribeChannel(subscriber, channel).catch((error) => {
                logger.error("[runChangeNotifier] Failed to re-subscribe to run-change channel", {
                  error,
                  channel,
                });
              });
            }
          })
          .catch((error) => {
            // UNSUBSCRIBE failed: the channel is likely still subscribed in Redis.
            // Keep the (empty) map entry so a future subscriber reuses it without a
            // duplicate SUBSCRIBE and #onMessage stays consistent with Redis state.
            logger.error("[runChangeNotifier] Failed to unsubscribe from run-change channel", {
              error,
              channel,
            });
          });
      }
    };

    return { changed, unsubscribe };
  }

  /** Number of distinct channels currently subscribed (for metrics). */
  get activeSubscriptionCount(): number {
    return this.#listeners.size;
  }

  async quit(): Promise<void> {
    for (const timer of this.#coalesceTimers.values()) {
      clearTimeout(timer);
    }
    this.#coalesceTimers.clear();
    this.#coalesceDirty.clear();
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
      const onMessage = (channel: string) => this.#onMessage(channel);
      // Classic pub/sub delivers "message"; sharded pub/sub delivers "smessage".
      // Register both so the delivery path is identical regardless of mode.
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

  #onMessage(channel: string) {
    // The per-env channel carries a busy environment's entire run-change firehose to
    // every tag/batch feed, so throttle it; the per-run channel is low-volume and
    // latency-sensitive, so deliver it immediately.
    if (this.#coalesceWindowMs > 0 && this.#isEnvChannel(channel)) {
      this.#deliverCoalesced(channel);
      return;
    }
    this.#deliver(channel);
  }

  #deliver(channel: string) {
    const listeners = this.#listeners.get(channel);
    if (!listeners) {
      return;
    }
    // One-shot: each waiter resolves its race and removes itself via unsubscribe().
    for (const resolve of [...listeners]) {
      resolve();
    }
  }

  /**
   * Leading-edge throttle: deliver the first wake immediately, then suppress further
   * wakes for the window, delivering one trailing wake if any messages arrived during
   * it (and re-opening while activity continues). Caps the feed-wake rate per env to
   * ~1/window no matter how fast runs change. Lossless: consumers refetch current
   * state on a wake, so a coalesced burst is captured by the next refetch.
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

  #isEnvChannel(channel: string): boolean {
    return channel.startsWith(`${this.#channelPrefix}env:`);
  }

  // Channels are hash-tagged (`...{<id>}`) so all of a run's/env's traffic maps to
  // one cluster slot (one shard) under sharded pub/sub.
  #channelForRun(runId: string): string {
    return `${this.#channelPrefix}run:{${runId}}`;
  }

  #channelForEnv(environmentId: string): string {
    return `${this.#channelPrefix}env:{${environmentId}}`;
  }
}
