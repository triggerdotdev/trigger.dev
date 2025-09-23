import { createRedisClient, RedisClient, RedisWithClusterOptions } from "~/redis.server";
import { EventEmitter } from "node:stream";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";

export type TracePubSubOptions = {
  redis: RedisWithClusterOptions;
};

export class TracePubSub {
  private _publisher: RedisClient;
  private _subscriberCount = 0;

  constructor(private _options: TracePubSubOptions) {
    this._publisher = createRedisClient("trigger:eventRepoPublisher", this._options.redis);
  }

  // TODO: do this more efficiently
  async publish(traceIds: string[]) {
    if (traceIds.length === 0) return;
    const uniqueTraces = new Set(traceIds.map((e) => `events:${e}`));

    await Promise.allSettled(
      Array.from(uniqueTraces).map((traceId) =>
        this._publisher.publish(traceId, new Date().toISOString())
      )
    );
  }

  async subscribeToTrace(traceId: string) {
    const redis = createRedisClient("trigger:eventRepoSubscriber", this._options.redis);

    const channel = `events:${traceId}`;

    // Subscribe to the channel.
    await redis.subscribe(channel);

    // Increment the subscriber count.
    this._subscriberCount++;

    const eventEmitter = new EventEmitter();

    // Define the message handler.
    redis.on("message", (_, message) => {
      eventEmitter.emit("message", message);
    });

    // Return a function that can be used to unsubscribe.
    const unsubscribe = async () => {
      await redis.unsubscribe(channel);
      redis.quit();
      this._subscriberCount--;
    };

    return {
      unsubscribe,
      eventEmitter,
    };
  }
}

export const tracePubSub = singleton("tracePubSub", initializeTracePubSub);

function initializeTracePubSub() {
  return new TracePubSub({
    redis: {
      port: env.PUBSUB_REDIS_PORT,
      host: env.PUBSUB_REDIS_HOST,
      username: env.PUBSUB_REDIS_USERNAME,
      password: env.PUBSUB_REDIS_PASSWORD,
      tlsDisabled: env.PUBSUB_REDIS_TLS_DISABLED === "true",
      clusterMode: env.PUBSUB_REDIS_CLUSTER_MODE_ENABLED === "1",
    },
  });
}
