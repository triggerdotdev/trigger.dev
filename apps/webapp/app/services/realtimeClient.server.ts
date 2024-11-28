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

export type RealtimeRunsParams = {
  tags?: string[];
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

  async streamRun(
    url: URL | string,
    environment: RealtimeEnvironment,
    runId: string,
    clientVersion?: string
  ) {
    return this.#streamRunsWhere(url, environment, `id='${runId}'`, clientVersion);
  }

  async streamBatch(
    url: URL | string,
    environment: RealtimeEnvironment,
    batchId: string,
    clientVersion?: string
  ) {
    return this.#streamRunsWhere(url, environment, `"batchId"='${batchId}'`, clientVersion);
  }

  async streamRuns(
    url: URL | string,
    environment: RealtimeEnvironment,
    params: RealtimeRunsParams,
    clientVersion?: string
  ) {
    const whereClauses: string[] = [`"runtimeEnvironmentId"='${environment.id}'`];

    if (params.tags) {
      whereClauses.push(`"runTags" @> ARRAY[${params.tags.map((t) => `'${t}'`).join(",")}]`);
    }

    const whereClause = whereClauses.join(" AND ");

    return this.#streamRunsWhere(url, environment, whereClause, clientVersion);
  }

  async #streamRunsWhere(
    url: URL | string,
    environment: RealtimeEnvironment,
    whereClause: string,
    clientVersion?: string
  ) {
    const electricUrl = this.#constructElectricUrl(url, whereClause, clientVersion);

    return this.#performElectricRequest(electricUrl, environment, clientVersion);
  }

  #constructElectricUrl(url: URL | string, whereClause: string, clientVersion?: string): URL {
    const $url = new URL(url.toString());

    const electricUrl = new URL(`${this.options.electricOrigin}/v1/shape`);

    // Copy over all the url search params to the electric url
    $url.searchParams.forEach((value, key) => {
      electricUrl.searchParams.set(key, value);
    });

    electricUrl.searchParams.set("where", whereClause);
    electricUrl.searchParams.set("table", 'public."TaskRun"');

    if (!clientVersion) {
      // If the client version is not provided, that means we're using an older client
      // This means the client will be sending shape_id instead of handle
      electricUrl.searchParams.set("handle", electricUrl.searchParams.get("shape_id") ?? "");
    }

    return electricUrl;
  }

  async #performElectricRequest(
    url: URL,
    environment: RealtimeEnvironment,
    clientVersion?: string
  ) {
    const shapeId = extractShapeId(url);

    logger.debug("[realtimeClient] request", {
      url: url.toString(),
    });

    const rewriteResponseHeaders: Record<string, string> = clientVersion
      ? {}
      : { "electric-handle": "electric-shape-id", "electric-offset": "electric-chunk-last-offset" };

    if (!shapeId) {
      // If the shapeId is not present, we're just getting the initial value
      return longPollingFetch(url.toString(), {}, rewriteResponseHeaders);
    }

    const isLive = isLiveRequestUrl(url);

    if (!isLive) {
      return longPollingFetch(url.toString(), {}, rewriteResponseHeaders);
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

      return json({ error: "Failed to get concurrency limit" }, { status: 500 });
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

      return json({ error: "Too many concurrent requests" }, { status: 429 });
    }

    try {
      // ... (rest of your existing code for the long polling request)
      const response = await longPollingFetch(url.toString(), {}, rewriteResponseHeaders);

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
  return url.searchParams.get("handle");
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
