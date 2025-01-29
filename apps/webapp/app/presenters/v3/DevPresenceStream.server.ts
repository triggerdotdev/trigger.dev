import { Redis } from "ioredis";
import { eventStream } from "remix-utils/sse/server";
import { interval } from "remix-utils/timers";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

const PRESENCE_KEY_PREFIX = "dev-presence:connection:";
const PRESENCE_CHANNEL_PREFIX = "dev-presence:updates:";

export class DevPresenceStream {
  #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  private getPresenceKey(environment: AuthenticatedEnvironment) {
    return `${PRESENCE_KEY_PREFIX}${environment.id}`;
  }

  private getPresenceChannel(environment: AuthenticatedEnvironment) {
    return `${PRESENCE_CHANNEL_PREFIX}${environment.id}`;
  }

  // This handles the CLI connection
  public async handleCliConnection({
    request,
    environment,
  }: {
    request: Request;
    environment: AuthenticatedEnvironment;
  }) {
    const presenceKey = this.getPresenceKey(environment);
    const presenceChannel = this.getPresenceChannel(environment);

    logger.debug("Start dev presence SSE session", {
      environmentId: environment.id,
      presenceKey,
      presenceChannel,
    });

    // Set initial presence with more context
    await this.#redis
      .multi()
      .hset(presenceKey, {
        lastSeen: Date.now().toString(),
        environmentId: environment.id,
      })
      .expire(presenceKey, env.DEV_PRESENCE_TTL_SECONDS)
      .exec();

    // Publish presence update
    await this.#redis.publish(
      presenceChannel,
      JSON.stringify({
        type: "connected",
        environmentId: environment.id,
        timestamp: Date.now(),
      })
    );

    const redis = this.#redis;

    return eventStream(request.signal, function setup(send) {
      async function run() {
        for await (let _ of interval(env.DEV_PRESENCE_REFRESH_INTERVAL_MS, {
          signal: request.signal,
        })) {
          await redis
            .multi()
            .hset(presenceKey, {
              lastSeen: Date.now().toString(),
              environmentId: environment.id,
            })
            .expire(presenceKey, env.DEV_PRESENCE_TTL_SECONDS)
            .exec();

          send({ event: "time", data: new Date().toISOString() });
        }
      }

      run();

      return async () => {
        logger.debug("Closing dev presence SSE session", {
          environmentId: environment.id,
          presenceKey,
          presenceChannel,
        });

        // Publish disconnect event
        await redis.publish(
          presenceChannel,
          JSON.stringify({
            type: "disconnected",
            environmentId: environment.id,
            timestamp: Date.now(),
          })
        );
      };
    });
  }

  //todo create a Redis client for each function call to subscribe
  //todo you can get the redis options, or there might be a clone function
}
