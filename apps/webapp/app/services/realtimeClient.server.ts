import Redis, { Callback, Result, type RedisOptions } from "ioredis";
import { longPollingFetch } from "~/utils/longPollingFetch";
import { getCachedLimit } from "./platform.v3.server";
import { logger } from "./logger.server";
import { AuthenticatedEnvironment } from "./apiAuth.server";
import { json } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";

export type RealtimeClientOptions = {
  electricOrigin: string;
  redis: RedisOptions;
  keyPrefix: string;
  expiryTime?: number;
};

export class RealtimeClient {
  private redis: Redis;
  private expiryTime: number;

  constructor(private options: RealtimeClientOptions) {
    this.redis = new Redis(options.redis);
    this.expiryTime = options.expiryTime ?? 3600; // default to 1 hour
    this.#registerCommands();
  }

  async streamRunsWhere(
    url: URL | string,
    authenticatedEnv: AuthenticatedEnvironment,
    whereClause: string,
    responseWrapper?: (response: Response) => Promise<Response>
  ) {
    const electricUrl = this.#constructElectricUrl(url, whereClause);

    return this.#performElectricRequest(electricUrl, authenticatedEnv, responseWrapper);
  }

  #constructElectricUrl(url: URL | string, whereClause: string): URL {
    const $url = new URL(url.toString());

    const electricUrl = new URL(`${this.options.electricOrigin}/v1/shape/public."TaskRun"`);

    $url.searchParams.forEach((value, key) => {
      electricUrl.searchParams.set(key, value);
    });

    electricUrl.searchParams.set("where", whereClause);

    return electricUrl;
  }

  async #performElectricRequest(
    url: URL,
    authenticatedEnv: AuthenticatedEnvironment,
    responseWrapper: (response: Response) => Promise<Response> = (r) => Promise.resolve(r)
  ) {
    const shapeId = extractShapeId(url);

    if (!shapeId) {
      // If the shapeId is not present, we're just getting the initial value
      return longPollingFetch(url.toString());
    }

    const isLive = isLiveRequestUrl(url);

    if (!isLive) {
      return longPollingFetch(url.toString());
    }

    // We now need to wrap the longPollingFetch in a concurrency tracker
    const concurrencyLimitResult = await getCachedLimit(
      authenticatedEnv.organizationId,
      "realtimeConcurrentConnections",
      100_000
    );

    if (!concurrencyLimitResult.val) {
      logger.error("Failed to get concurrency limit", {
        organizationId: authenticatedEnv.organizationId,
        concurrencyLimitResult,
      });

      return responseWrapper(json({ error: "Failed to get concurrency limit" }, { status: 500 }));
    }

    const concurrencyLimit = concurrencyLimitResult.val;

    logger.debug("[realtimeClient] increment and check", {
      concurrencyLimit,
      shapeId,
      authenticatedEnv: {
        id: authenticatedEnv.id,
        organizationId: authenticatedEnv.organizationId,
      },
    });

    const canProceed = await this.#incrementAndCheck(
      authenticatedEnv.id,
      shapeId,
      concurrencyLimit
    );

    if (!canProceed) {
      return responseWrapper(json({ error: "Too many concurrent requests" }, { status: 429 }));
    }

    try {
      // ... (rest of your existing code for the long polling request)
      const response = await longPollingFetch(url.toString());

      // Decrement the counter after the long polling request is complete
      await this.#decrementConcurrency(authenticatedEnv.id, shapeId);

      return response;
    } catch (error) {
      // Decrement the counter if the request fails
      await this.#decrementConcurrency(authenticatedEnv.id, shapeId);

      throw error;
    }
  }

  async #incrementAndCheck(environmentId: string, shapeId: string, limit: number) {
    const key = this.#getKey(environmentId);
    const now = Date.now().toString();

    const result = await this.redis.incrementAndCheckConcurrency(
      key,
      now,
      shapeId,
      this.expiryTime.toString(),
      limit.toString()
    );

    return result === 1;
  }

  async #decrementConcurrency(environmentId: string, shapeId: string) {
    logger.debug("[realtimeClient] decrement", {
      shapeId,
      environmentId,
    });

    const key = this.#getKey(environmentId);

    await this.redis.zrem(key, shapeId);
  }

  #getKey(environmentId: string): string {
    return `${this.options.keyPrefix}:${environmentId}`;
  }

  #registerCommands() {
    this.redis.defineCommand("incrementAndCheckConcurrency", {
      numberOfKeys: 1,
      lua: `
        local concurrencyKey = KEYS[1]

        local timestamp = ARGV[1]
        local requestId = ARGV[2]
        local expiryTime = ARGV[3]
        local limit = tonumber(ARGV[4])

        -- Add the new request to the sorted set
        redis.call('ZADD', concurrencyKey, timestamp, requestId)

        -- Set the expiry time on the key
        redis.call('EXPIRE', concurrencyKey, expiryTime)

        -- Get the total number of concurrent requests
        local totalRequests = redis.call('ZCARD', concurrencyKey)

        -- Check if the limit has been exceeded
        if totalRequests > limit then
            -- Remove the request we just added
            redis.call('ZREM', concurrencyKey, requestId)
            return 0
        end

        -- Return 1 to indicate success
        return 1
      `,
    });
  }
}

function extractShapeId(url: URL) {
  return url.searchParams.get("shape_id");
}

function isLiveRequestUrl(url: URL) {
  return url.searchParams.has("live") && url.searchParams.get("live") === "true";
}

declare module "ioredis" {
  interface RedisCommander<Context> {
    incrementAndCheckConcurrency(
      key: string,
      timestamp: string,
      requestId: string,
      expiryTime: string,
      limit: string,
      callback?: Callback<number>
    ): Result<number, Context>;
  }
}

function initializeRealtimeClient() {
  return new RealtimeClient({
    electricOrigin: env.ELECTRIC_ORIGIN,
    keyPrefix: `tr:realtime:concurrency`,
    redis: {
      port: env.REDIS_PORT,
      host: env.REDIS_HOST,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    },
  });
}

export const realtimeClient = singleton("realtimeClient", initializeRealtimeClient);
