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
};

export type RunChangeSubscription = {
  /** Resolves the next time a change is published for the subscribed run. */
  changed: Promise<void>;
  unsubscribe: () => void;
};

const DEFAULT_CHANNEL_PREFIX = "realtime:";

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
 * Channels are hash-tagged (`<prefix>{<runId>}`) so a later move to sharded
 * pub/sub (SPUBLISH/SSUBSCRIBE) keeps slot locality without a channel rename.
 */
export class RunChangeNotifier {
  #publisher: RedisClient | undefined;
  #subscriber: RedisClient | undefined;
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #channelPrefix: string;
  readonly #connectionName: string;

  constructor(private readonly options: RunChangeNotifierOptions) {
    this.#channelPrefix = options.channelPrefix ?? DEFAULT_CHANNEL_PREFIX;
    this.#connectionName = options.connectionName ?? "trigger:realtime:run-change-notifier";
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
      const result = publisher.publish(channel, payload);
      if (typeof (result as Promise<number>)?.catch === "function") {
        (result as Promise<number>).catch((error) => {
          logger.debug("[runChangeNotifier] publish failed", { error, channel });
        });
      }
    } catch (error) {
      logger.debug("[runChangeNotifier] publish threw", { error, channel });
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
      subscriber.subscribe(channel).catch((error) => {
        logger.debug("[runChangeNotifier] subscribe failed", { error, channel });
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
        subscriber
          .unsubscribe(channel)
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
              subscriber.subscribe(channel).catch((error) => {
                logger.debug("[runChangeNotifier] resubscribe failed", { error, channel });
              });
            }
          })
          .catch((error) => {
            // UNSUBSCRIBE failed: the channel is likely still subscribed in Redis.
            // Keep the (empty) map entry so a future subscriber reuses it without a
            // duplicate SUBSCRIBE and #onMessage stays consistent with Redis state.
            logger.debug("[runChangeNotifier] unsubscribe failed", { error, channel });
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
      subscriber.on("message", (channel: string) => this.#onMessage(channel));
      this.#subscriber = subscriber;
    }
    return this.#subscriber;
  }

  #onMessage(channel: string) {
    const listeners = this.#listeners.get(channel);
    if (!listeners) {
      return;
    }
    // One-shot: each waiter resolves its race and removes itself via unsubscribe().
    for (const resolve of [...listeners]) {
      resolve();
    }
  }

  // Channels are hash-tagged (`...{<id>}`) so a later move to sharded pub/sub
  // keeps slot locality without a rename.
  #channelForRun(runId: string): string {
    return `${this.#channelPrefix}run:{${runId}}`;
  }

  #channelForEnv(environmentId: string): string {
    return `${this.#channelPrefix}env:{${environmentId}}`;
  }
}
