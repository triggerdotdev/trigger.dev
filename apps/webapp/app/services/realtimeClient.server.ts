import { json } from "@remix-run/server-runtime";
import Redis, { Callback, Result, type RedisOptions } from "ioredis";
import { randomUUID } from "node:crypto";
import { longPollingFetch } from "~/utils/longPollingFetch";
import { logger } from "./logger.server";

export interface CachedLimitProvider {
  getCachedLimit: (organizationId: string, defaultValue: number) => Promise<number | undefined>;
}

export type RealtimeClientOptions = {
  electricOrigin: string;
  redis: RedisOptions;
  cachedLimitProvider: CachedLimitProvider;
  keyPrefix: string;
  expiryTimeInSeconds?: number;
};

export type RealtimeEnvironment = {
  id: string;
  organizationId: string;
};

export class RealtimeClient {
  private redis: Redis;
  private expiryTimeInSeconds: number;
  private cachedLimitProvider: CachedLimitProvider;

  constructor(private options: RealtimeClientOptions) {
    this.redis = new Redis(options.redis);
    this.expiryTimeInSeconds = options.expiryTimeInSeconds ?? 60 * 5; // default to 5 minutes
    this.cachedLimitProvider = options.cachedLimitProvider;
    this.#registerCommands();
  }

  async streamRunsWhere(
    url: URL | string,
    environment: RealtimeEnvironment,
    whereClause: string,
    responseWrapper?: (response: Response) => Promise<Response>
  ) {
    const electricUrl = this.#constructElectricUrl(url, whereClause);

    return this.#performElectricRequest(electricUrl, environment, responseWrapper);
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
    environment: RealtimeEnvironment,
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

    const requestId = randomUUID();

    // We now need to wrap the longPollingFetch in a concurrency tracker
    const concurrencyLimit = await this.cachedLimitProvider.getCachedLimit(
      environment.organizationId,
      100_000
    );

    if (!concurrencyLimit) {
      logger.error("Failed to get concurrency limit", {
        organizationId: environment.organizationId,
      });

      return responseWrapper(json({ error: "Failed to get concurrency limit" }, { status: 500 }));
    }

    logger.debug("[realtimeClient] increment and check", {
      concurrencyLimit,
      shapeId,
      requestId,
      environment: {
        id: environment.id,
        organizationId: environment.organizationId,
      },
    });

    const canProceed = await this.#incrementAndCheck(environment.id, requestId, concurrencyLimit);

    if (!canProceed) {
      logger.debug("[realtimeClient] too many concurrent requests", {
        requestId,
        environmentId: environment.id,
      });

      return responseWrapper(json({ error: "Too many concurrent requests" }, { status: 429 }));
    }

    try {
      // ... (rest of your existing code for the long polling request)
      const response = await longPollingFetch(url.toString());

      // Decrement the counter after the long polling request is complete
      await this.#decrementConcurrency(environment.id, requestId);

      return response;
    } catch (error) {
      // Decrement the counter if the request fails
      await this.#decrementConcurrency(environment.id, requestId);

      throw error;
    }
  }

  async #incrementAndCheck(environmentId: string, requestId: string, limit: number) {
    const key = this.#getKey(environmentId);
    const now = Date.now();

    const result = await this.redis.incrementAndCheckConcurrency(
      key,
      now.toString(),
      requestId,
      this.expiryTimeInSeconds.toString(), // expiry time
      (now - this.expiryTimeInSeconds * 1000).toString(), // cutoff time
      limit.toString()
    );

    return result === 1;
  }

  async #decrementConcurrency(environmentId: string, requestId: string) {
    logger.debug("[realtimeClient] decrement", {
      requestId,
      environmentId,
    });

    const key = this.#getKey(environmentId);

    await this.redis.zrem(key, requestId);
  }

  #getKey(environmentId: string): string {
    return `${this.options.keyPrefix}:${environmentId}`;
  }

  #registerCommands() {
    this.redis.defineCommand("incrementAndCheckConcurrency", {
      numberOfKeys: 1,
      lua: /* lua */ `
        local concurrencyKey = KEYS[1]

        local timestamp = tonumber(ARGV[1])
        local requestId = ARGV[2]
        local expiryTime = tonumber(ARGV[3])
        local cutoffTime = tonumber(ARGV[4])
        local limit = tonumber(ARGV[5])

        -- Remove expired entries
        redis.call('ZREMRANGEBYSCORE', concurrencyKey, '-inf', cutoffTime)

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
      cutoffTime: string,
      limit: string,
      callback?: Callback<number>
    ): Result<number, Context>;
  }
}
