import { EventEmitter } from "node:events";
import { env } from "~/env.server";
import { createRedisClient, type RedisClient, type RedisWithClusterOptions } from "~/redis.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";

/**
 * Pub/sub channel used to notify webapp replicas that the in-memory LLM
 * pricing registry should reload from Postgres. Published by admin routes
 * whenever an LlmModel row is mutated, and by the billing-app trigger.dev
 * tasks (via the admin reload endpoint) whenever they upsert rows.
 */
export const LLM_REGISTRY_RELOAD_CHANNEL = "llm-registry:reload";

type LlmRegistryPubSubOptions = {
  redis: RedisWithClusterOptions;
};

/**
 * Thin publish/subscribe wrapper around ioredis for the LLM pricing registry.
 * The payload is intentionally tiny (a timestamp) because subscribers always
 * perform a full reload — there's no incremental diff.
 */
export class LlmRegistryPubSub {
  private _publisher: RedisClient;
  private _subscriber: RedisClient | null = null;
  private _emitter = new EventEmitter();

  constructor(private _options: LlmRegistryPubSubOptions) {
    this._publisher = createRedisClient("llm-registry:publisher", this._options.redis);
  }

  /** Notifies all webapp replicas that they should reload the registry. */
  async publishReload(reason?: string): Promise<void> {
    try {
      await this._publisher.publish(
        LLM_REGISTRY_RELOAD_CHANNEL,
        JSON.stringify({ at: new Date().toISOString(), reason: reason ?? "unspecified" })
      );
    } catch (error) {
      logger.error("Failed to publish llm-registry reload", { error });
    }
  }

  /**
   * Subscribes this process to reload notifications. The supplied handler is
   * called every time any replica publishes a reload; it should be idempotent
   * and reasonably fast (the caller should usually just invoke
   * `registry.reload()`).
   */
  async subscribe(handler: (reason: string) => void | Promise<void>): Promise<() => Promise<void>> {
    if (this._subscriber) {
      throw new Error("LlmRegistryPubSub already subscribed from this process");
    }

    const subscriber = createRedisClient("llm-registry:subscriber", this._options.redis);
    this._subscriber = subscriber;

    await subscriber.subscribe(LLM_REGISTRY_RELOAD_CHANNEL);

    const messageHandler = (channel: string, message: string) => {
      if (channel !== LLM_REGISTRY_RELOAD_CHANNEL) return;

      let reason = "unspecified";
      try {
        const parsed = JSON.parse(message) as { reason?: string };
        if (typeof parsed.reason === "string") reason = parsed.reason;
      } catch {
        // Old-format message — ignore the parse error, the handler fires anyway.
      }

      Promise.resolve(handler(reason)).catch((error) => {
        logger.error("llm-registry reload handler threw", { error, reason });
      });

      this._emitter.emit("reload", reason);
    };

    subscriber.on("message", messageHandler);

    return async () => {
      subscriber.off("message", messageHandler);
      try {
        await subscriber.unsubscribe(LLM_REGISTRY_RELOAD_CHANNEL);
      } catch {
        // Ignore — we're shutting down.
      }
      await subscriber.quit().catch(() => undefined);
      this._subscriber = null;
    };
  }

  on(event: "reload", listener: (reason: string) => void): void {
    this._emitter.on(event, listener);
  }
}

export const llmRegistryPubSub = singleton("llmRegistryPubSub", () => {
  return new LlmRegistryPubSub({
    redis: {
      port: env.PUBSUB_REDIS_PORT,
      host: env.PUBSUB_REDIS_HOST,
      username: env.PUBSUB_REDIS_USERNAME,
      password: env.PUBSUB_REDIS_PASSWORD,
      tlsDisabled: env.PUBSUB_REDIS_TLS_DISABLED === "true",
      clusterMode: env.PUBSUB_REDIS_CLUSTER_MODE_ENABLED === "1",
    },
  });
});
