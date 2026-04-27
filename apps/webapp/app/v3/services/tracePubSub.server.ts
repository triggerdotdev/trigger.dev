import { createRedisClient, RedisClient, RedisWithClusterOptions } from "~/redis.server";
import { EventEmitter } from "node:events";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { Gauge } from "prom-client";
import { metricsRegister } from "~/metrics.server";

export type TracePubSubOptions = {
  redis: RedisWithClusterOptions;
};

export class TracePubSub {
  private _publisher: RedisClient;
  private _subscriberCount = 0;

  constructor(private _options: TracePubSubOptions) {
    this._publisher = createRedisClient("trigger:eventRepoPublisher", this._options.redis);
  }

  get subscriberCount() {
    return this._subscriberCount;
  }

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

    // Define the message handler - store reference so we can remove it later.
    const messageHandler = (_: string, message: string) => {
      eventEmitter.emit("message", message);
    };
    redis.on("message", messageHandler);

    // Return a function that can be used to unsubscribe.
    const unsubscribe = async () => {
      // Remove the message listener before closing the connection
      redis.off("message", messageHandler);
      await redis.unsubscribe(channel);
      await redis.quit();
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
  const pubSub = new TracePubSub({
    redis: {
      port: env.PUBSUB_REDIS_PORT,
      host: env.PUBSUB_REDIS_HOST,
      username: env.PUBSUB_REDIS_USERNAME,
      password: env.PUBSUB_REDIS_PASSWORD,
      tlsDisabled: env.PUBSUB_REDIS_TLS_DISABLED === "true",
      clusterMode: env.PUBSUB_REDIS_CLUSTER_MODE_ENABLED === "1",
    },
  });

  new Gauge({
    name: "trace_pub_sub_subscribers",
    help: "Number of trace pub sub subscribers",
    collect() {
      this.set(pubSub.subscriberCount);
    },
    registers: [metricsRegister],
  });

  return pubSub;
}
