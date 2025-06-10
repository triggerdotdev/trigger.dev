import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { safeParseNaturalLanguageDurationAgo } from "@trigger.dev/core/v3/isomorphic";
import { Callback, Result } from "ioredis";
import { randomUUID } from "node:crypto";
import { createRedisClient, RedisClient, RedisWithClusterOptions } from "~/redis.server";
import { longPollingFetch } from "~/utils/longPollingFetch";
import { logger } from "./logger.server";
import { jumpHash } from "@trigger.dev/core/v3/serverOnly";
import { Cache, createCache, DefaultStatefulContext, Namespace } from "@unkey/cache";
import { MemoryStore } from "@unkey/cache/stores";
import { RedisCacheStore } from "./unkey/redisCacheStore.server";
import { env } from "~/env.server";

export interface CachedLimitProvider {
  getCachedLimit: (organizationId: string, defaultValue: number) => Promise<number | undefined>;
}

const DEFAULT_ELECTRIC_COLUMNS = [
  "id",
  "taskIdentifier",
  "createdAt",
  "updatedAt",
  "startedAt",
  "delayUntil",
  "queuedAt",
  "expiredAt",
  "completedAt",
  "friendlyId",
  "number",
  "isTest",
  "status",
  "usageDurationMs",
  "costInCents",
  "baseCostInCents",
  "ttl",
  "payload",
  "payloadType",
  "metadata",
  "metadataType",
  "output",
  "outputType",
  "runTags",
  "error",
];

const RESERVED_COLUMNS = ["id", "taskIdentifier", "friendlyId", "status", "createdAt"];
const RESERVED_SEARCH_PARAMS = ["createdAt", "tags", "skipColumns"];

export type RealtimeClientOptions = {
  electricOrigin: string | string[];
  redis: RedisWithClusterOptions;
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
  createdAt?: string;
};

export class RealtimeClient {
  private redis: RedisClient;
  private expiryTimeInSeconds: number;
  private cachedLimitProvider: CachedLimitProvider;
  private cache: Cache<{ createdAtFilter: string }>;

  constructor(private options: RealtimeClientOptions) {
    this.redis = createRedisClient("trigger:realtime", options.redis);
    this.expiryTimeInSeconds = options.expiryTimeInSeconds ?? 60 * 5; // default to 5 minutes
    this.cachedLimitProvider = options.cachedLimitProvider;
    this.#registerCommands();

    const ctx = new DefaultStatefulContext();
    const memory = new MemoryStore({ persistentMap: new Map() });
    const redisCacheStore = new RedisCacheStore({
      connection: {
        keyPrefix: "tr:cache:realtime",
        port: options.redis.port,
        host: options.redis.host,
        username: options.redis.username,
        password: options.redis.password,
        tlsDisabled: options.redis.tlsDisabled,
        clusterMode: options.redis.clusterMode,
      },
    });

    // This cache holds the limits fetched from the platform service
    const cache = createCache({
      createdAtFilter: new Namespace<string>(ctx, {
        stores: [memory, redisCacheStore],
        fresh: 60_000 * 60 * 24 * 7, // 1 week
        stale: 60_000 * 60 * 24 * 14, // 2 weeks
      }),
    });

    this.cache = cache;
  }

  async streamChunks(
    url: URL | string,
    environment: RealtimeEnvironment,
    runId: string,
    streamId: string,
    signal?: AbortSignal,
    clientVersion?: string
  ) {
    return this.#streamChunksWhere(
      url,
      environment,
      `"runId"='${runId}' AND "key"='${streamId}'`,
      signal,
      clientVersion
    );
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
    const whereClauses: string[] = [
      `"runtimeEnvironmentId"='${environment.id}'`,
      `"batchId"='${batchId}'`,
    ];

    const whereClause = whereClauses.join(" AND ");

    return this.#streamRunsWhere(url, environment, whereClause, clientVersion);
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

    const createdAtFilter = await this.#calculateCreatedAtFilter(url, params.createdAt);

    if (createdAtFilter) {
      whereClauses.push(`"createdAt" > '${createdAtFilter.toISOString()}'`);
    }

    const whereClause = whereClauses.join(" AND ");

    const response = await this.#streamRunsWhere(url, environment, whereClause, clientVersion);

    if (createdAtFilter) {
      const [setCreatedAtFilterError] = await tryCatch(
        this.#setCreatedAtFilterFromResponse(response, createdAtFilter)
      );

      if (setCreatedAtFilterError) {
        logger.error("[realtimeClient] Failed to set createdAt filter", {
          error: setCreatedAtFilterError,
          createdAtFilter,
          responseHeaders: Object.fromEntries(response.headers.entries()),
          responseStatus: response.status,
        });
      }
    }

    return response;
  }

  async #calculateCreatedAtFilter(url: URL | string, createdAt?: string) {
    const duration = createdAt ?? "24h";
    const $url = new URL(url.toString());
    const shapeId = extractShapeId($url);

    if (!shapeId) {
      // This means we need to calculate the createdAt filter and store it in redis after we get back the response
      const createdAtFilter = safeParseNaturalLanguageDurationAgo(duration);

      // Validate that the createdAt filter is in the past, and not more than the maximum age in the past.
      // if it's more than the maximum age in the past, just return the maximum age in the past Date
      if (
        createdAtFilter &&
        createdAtFilter < new Date(Date.now() - env.REALTIME_MAXIMUM_CREATED_AT_FILTER_AGE_IN_MS)
      ) {
        return new Date(Date.now() - env.REALTIME_MAXIMUM_CREATED_AT_FILTER_AGE_IN_MS);
      }

      return createdAtFilter;
    } else {
      // We need to get the createdAt filter value from redis, if there is none we need to return undefined
      const [createdAtFilterError, createdAtFilter] = await tryCatch(
        this.#getCreatedAtFilter(shapeId)
      );

      if (createdAtFilterError) {
        logger.error("[realtimeClient] Failed to get createdAt filter", {
          shapeId,
          error: createdAtFilterError,
        });

        return;
      }

      return createdAtFilter;
    }
  }

  async #getCreatedAtFilter(shapeId: string) {
    const createdAtFilterCacheResult = await this.cache.createdAtFilter.get(shapeId);

    if (createdAtFilterCacheResult.err) {
      logger.error("[realtimeClient] Failed to get createdAt filter", {
        shapeId,
        error: createdAtFilterCacheResult.err,
      });

      return;
    }

    if (!createdAtFilterCacheResult.val) {
      return;
    }

    return new Date(createdAtFilterCacheResult.val);
  }

  async #setCreatedAtFilterFromResponse(response: Response, createdAtFilter: Date) {
    const shapeId = extractShapeIdFromResponse(response);

    if (!shapeId) {
      return;
    }

    await this.cache.createdAtFilter.set(shapeId, createdAtFilter.toISOString());
  }

  async #streamRunsWhere(
    url: URL | string,
    environment: RealtimeEnvironment,
    whereClause: string,
    clientVersion?: string
  ) {
    const electricUrl = this.#constructRunsElectricUrl(
      url,
      environment,
      whereClause,
      clientVersion
    );

    return this.#performElectricRequest(electricUrl, environment, undefined, clientVersion);
  }

  #constructRunsElectricUrl(
    url: URL | string,
    environment: RealtimeEnvironment,
    whereClause: string,
    clientVersion?: string
  ): URL {
    const $url = new URL(url.toString());

    const electricOrigin = this.#resolveElectricOrigin(environment.id);
    const electricUrl = new URL(`${electricOrigin}/v1/shape`);

    // Copy over all the url search params to the electric url
    $url.searchParams.forEach((value, key) => {
      if (RESERVED_SEARCH_PARAMS.includes(key)) {
        return;
      }

      electricUrl.searchParams.set(key, value);
    });

    electricUrl.searchParams.set("where", whereClause);
    electricUrl.searchParams.set("table", 'public."TaskRun"');

    if (!clientVersion) {
      // If the client version is not provided, that means we're using an older client
      // This means the client will be sending shape_id instead of handle
      electricUrl.searchParams.set("handle", electricUrl.searchParams.get("shape_id") ?? "");
    }

    const skipColumnsRaw = $url.searchParams.get("skipColumns");

    if (skipColumnsRaw) {
      const skipColumns = skipColumnsRaw
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c !== "" && !RESERVED_COLUMNS.includes(c));

      electricUrl.searchParams.set(
        "columns",
        DEFAULT_ELECTRIC_COLUMNS.filter((c) => !skipColumns.includes(c))
          .map((c) => `"${c}"`)
          .join(",")
      );
    } else {
      electricUrl.searchParams.set(
        "columns",
        DEFAULT_ELECTRIC_COLUMNS.map((c) => `"${c}"`).join(",")
      );
    }

    return electricUrl;
  }

  async #streamChunksWhere(
    url: URL | string,
    environment: RealtimeEnvironment,
    whereClause: string,
    signal?: AbortSignal,
    clientVersion?: string
  ) {
    const electricUrl = this.#constructChunksElectricUrl(url, whereClause, clientVersion);

    return this.#performElectricRequest(electricUrl, environment, signal, clientVersion);
  }

  #constructChunksElectricUrl(url: URL | string, whereClause: string, clientVersion?: string): URL {
    const $url = new URL(url.toString());

    const electricUrl = new URL(`${this.options.electricOrigin}/v1/shape`);

    // Copy over all the url search params to the electric url
    $url.searchParams.forEach((value, key) => {
      electricUrl.searchParams.set(key, value);
    });

    electricUrl.searchParams.set("where", whereClause);
    electricUrl.searchParams.set("table", `public."RealtimeStreamChunk"`);

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
    signal?: AbortSignal,
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
      return longPollingFetch(url.toString(), { signal }, rewriteResponseHeaders);
    }

    const isLive = isLiveRequestUrl(url);

    if (!isLive) {
      return longPollingFetch(url.toString(), { signal }, rewriteResponseHeaders);
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
      const response = await longPollingFetch(url.toString(), { signal }, rewriteResponseHeaders);

      // If this is the initial request, the response.headers['electric-handle'] will be the shapeId
      // And we may need to set the "createdAt" filter timestamp keyed by the shapeId
      // Then in the next request, we will get the createdAt timestamp value via the shapeId and use it to filter the results

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

  #resolveElectricOrigin(environmentId: string) {
    if (typeof this.options.electricOrigin === "string") {
      return this.options.electricOrigin;
    }

    const index = jumpHash(environmentId, this.options.electricOrigin.length);

    return this.options.electricOrigin[index] ?? this.options.electricOrigin[0];
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
  return url.searchParams.get("handle") ?? url.searchParams.get("shape_id");
}

function extractShapeIdFromResponse(response: Response) {
  return response.headers.get("electric-handle");
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
