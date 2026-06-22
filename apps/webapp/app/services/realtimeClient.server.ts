import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { isKsuidId, safeParseNaturalLanguageDurationAgo } from "@trigger.dev/core/v3/isomorphic";
import {
  decodeCompositeOffset,
  decodeCompositePart,
  mergeParsedShapes,
  MUST_REFETCH_MESSAGE,
  parseShapeMessages,
  unpolledShape,
  UP_TO_DATE_MESSAGE,
  type MergedShape,
  type ParsedShape,
  type PriorContinuation,
} from "./realtime/electricShapeMerge.server";
import { Callback, Result } from "ioredis";
import { randomUUID } from "node:crypto";
import { createRedisClient, RedisClient, RedisWithClusterOptions } from "~/redis.server";
import { longPollingFetch } from "~/utils/longPollingFetch";
import { logger } from "./logger.server";
import { jumpHash } from "@trigger.dev/core/v3/serverOnly";
import { Cache, createCache, DefaultStatefulContext, Namespace } from "@unkey/cache";
import { createLRUMemoryStore } from "@internal/cache";
import { RedisCacheStore } from "./unkey/redisCacheStore.server";
import { env } from "~/env.server";
import { API_VERSIONS, CURRENT_API_VERSION } from "~/api/versions";

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
  "realtimeStreams",
];

const RESERVED_COLUMNS = ["id", "taskIdentifier", "friendlyId", "status", "createdAt"];
const RESERVED_SEARCH_PARAMS = ["createdAt", "tags", "skipColumns"];

// The two physical run tables a realtime shape can target. A run lives in
// exactly one, keyed by id format (ksuid -> task_run_v2, cuid -> TaskRun).
const TASK_RUN_TABLE = 'public."TaskRun"';
const TASK_RUN_V2_TABLE = 'public."task_run_v2"';

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

export type RealtimeRequestOptions = {
  skipColumns?: string[];
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
    const memory = createLRUMemoryStore(1000);
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

  async streamRun(
    url: URL | string,
    environment: RealtimeEnvironment,
    runId: string,
    apiVersion: API_VERSIONS,
    requestOptions?: RealtimeRequestOptions,
    clientVersion?: string,
    signal?: AbortSignal
  ) {
    // Route the shape to the physical table the run lives in: a v2 run's id is
    // a KSUID (task_run_v2), a legacy run's a cuid (TaskRun). The run was
    // already resolved by the route, so this id is authoritative.
    const table = isKsuidId(runId) ? TASK_RUN_V2_TABLE : TASK_RUN_TABLE;
    return this.#streamRunsWhere(
      url,
      environment,
      `id='${runId}'`,
      table,
      apiVersion,
      requestOptions,
      clientVersion,
      signal
    );
  }

  async streamBatch(
    url: URL | string,
    environment: RealtimeEnvironment,
    batchId: string,
    apiVersion: API_VERSIONS,
    requestOptions?: RealtimeRequestOptions,
    clientVersion?: string,
    signal?: AbortSignal
  ) {
    const whereClauses: string[] = [
      `"runtimeEnvironmentId"='${environment.id}'`,
      `"batchId"='${batchId}'`,
    ];

    const whereClause = whereClauses.join(" AND ");

    return this.#streamRunsAcrossTables(
      url,
      environment,
      whereClause,
      apiVersion,
      requestOptions,
      clientVersion,
      signal
    );
  }

  async streamRuns(
    url: URL | string,
    environment: RealtimeEnvironment,
    params: RealtimeRunsParams,
    apiVersion: API_VERSIONS,
    requestOptions?: RealtimeRequestOptions,
    clientVersion?: string,
    signal?: AbortSignal
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

    const response = await this.#streamRunsAcrossTables(
      url,
      environment,
      whereClause,
      apiVersion,
      requestOptions,
      clientVersion,
      signal
    );

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
    table: string,
    apiVersion: API_VERSIONS,
    requestOptions?: RealtimeRequestOptions,
    clientVersion?: string,
    signal?: AbortSignal
  ) {
    const electricUrl = this.#constructRunsElectricUrl(
      url,
      environment,
      whereClause,
      table,
      requestOptions,
      clientVersion
    );

    return this.#performElectricRequest(
      electricUrl,
      environment,
      apiVersion,
      signal,
      clientVersion
    );
  }

  // Stream a feed that spans BOTH physical run tables (the tag-list and batch
  // feeds) by running two upstream Electric shapes — public."TaskRun" and
  // public."task_run_v2" — under a single composite continuation the client
  // round-trips opaquely. A run lives in exactly one table, so the union of the
  // two shapes is the full feed; the client merges by row key and never learns
  // there are two shapes. See electricShapeMerge.server.ts for the pure logic.
  //
  // Cost: this opens TWO upstream Electric long-polls per tag/batch
  // subscription (vs one for a single-table feed), so these feeds use ~2x
  // Electric connections while an org has runs across both tables. Single-run
  // subscriptions are unaffected — one shape, routed to the run's table by id
  // format.
  async #streamRunsAcrossTables(
    url: URL | string,
    environment: RealtimeEnvironment,
    whereClause: string,
    apiVersion: API_VERSIONS,
    requestOptions?: RealtimeRequestOptions,
    clientVersion?: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const $url = new URL(url.toString());
    const isLive = isLiveRequestUrl($url);
    const incomingHandle = extractShapeId($url);
    const incomingOffset = $url.searchParams.get("offset") ?? "-1";
    const incomingCursor = $url.searchParams.get("cursor");

    const handles = decodeCompositePart(incomingHandle);
    const offsets = decodeCompositeOffset(incomingOffset);
    const cursors = decodeCompositePart(incomingCursor);

    const prior: PriorContinuation = {
      handleA: handles.a,
      offsetA: offsets.a,
      cursorA: cursors.a,
      handleB: handles.b,
      offsetB: offsets.b,
      cursorB: cursors.b,
    };

    const urlA = this.#constructMergeShapeUrl(
      $url,
      environment,
      whereClause,
      TASK_RUN_TABLE,
      { handle: handles.a, offset: offsets.a, cursor: cursors.a },
      requestOptions,
      clientVersion
    );
    const urlB = this.#constructMergeShapeUrl(
      $url,
      environment,
      whereClause,
      TASK_RUN_V2_TABLE,
      { handle: handles.b, offset: offsets.b, cursor: cursors.b },
      requestOptions,
      clientVersion
    );

    // One concurrency slot for the composite live request: it maps to a single
    // client request even though we fan out to two upstream long-polls.
    let requestId: string | undefined;
    if (isLive && incomingHandle) {
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
      requestId = randomUUID();
      if (!(await this.#incrementAndCheck(environment.id, requestId, concurrencyLimit))) {
        return json({ error: "Too many concurrent requests" }, { status: 429 });
      }
    }

    try {
      const merged = await this.#raceAndMergeShapes(urlA, urlB, isLive, prior, signal);
      return this.#buildMergeResponse(merged, isLive, apiVersion, clientVersion);
    } finally {
      if (requestId) {
        await this.#decrementConcurrency(environment.id, requestId);
      }
    }
  }

  // Build the per-table Electric URL, replacing the composite continuation the
  // client sent with this table's decoded part.
  #constructMergeShapeUrl(
    baseUrl: URL,
    environment: RealtimeEnvironment,
    whereClause: string,
    table: string,
    perTable: { handle?: string; offset: string; cursor?: string },
    requestOptions?: RealtimeRequestOptions,
    clientVersion?: string
  ): URL {
    const electricUrl = this.#constructRunsElectricUrl(
      baseUrl,
      environment,
      whereClause,
      table,
      requestOptions,
      clientVersion
    );
    // Upstream always speaks current Electric (handle, not shape_id).
    electricUrl.searchParams.delete("shape_id");
    if (perTable.handle !== undefined) {
      electricUrl.searchParams.set("handle", perTable.handle);
    } else {
      electricUrl.searchParams.delete("handle");
    }
    electricUrl.searchParams.set("offset", perTable.offset);
    if (perTable.cursor !== undefined) {
      electricUrl.searchParams.set("cursor", perTable.cursor);
    } else {
      electricUrl.searchParams.delete("cursor");
    }
    return electricUrl;
  }

  // Fetch both shapes. For a live request, return as soon as ONE yields changes
  // (or needs a refetch) and carry the other's prior continuation forward — so a
  // change on either table isn't delayed by the other's idle long-poll. If the
  // first to settle had nothing, wait for the other before responding.
  async #raceAndMergeShapes(
    urlA: URL,
    urlB: URL,
    isLive: boolean,
    prior: PriorContinuation,
    signal?: AbortSignal
  ): Promise<MergedShape> {
    const ctlA = new AbortController();
    const ctlB = new AbortController();
    const link = (ctl: AbortController) =>
      signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal;

    let aRes: ParsedShape | undefined;
    let bRes: ParsedShape | undefined;
    const pA = this.#fetchShape(urlA, link(ctlA)).then((r) => {
      aRes = r;
      return "a" as const;
    });
    const pB = this.#fetchShape(urlB, link(ctlB)).then((r) => {
      bRes = r;
      return "b" as const;
    });
    // A shape we don't end up awaiting (the race loser we abort, or the sibling
    // left pending when the catch below rethrows) must not surface as an
    // unhandled rejection. Attach detached no-op catches up front; the
    // race/await paths still observe the original rejections through their own
    // reactions, so this only swallows an otherwise-orphaned rejection.
    void pA.catch(() => {});
    void pB.catch(() => {});

    try {
      if (!isLive) {
        await Promise.all([pA, pB]);
        return mergeParsedShapes(aRes!, bRes!, prior);
      }

      const actionable = (r: ParsedShape) =>
        r.mustRefetch || r.status >= 400 || r.changes.length > 0;

      const first = await Promise.race([pA, pB]);
      const firstRes = first === "a" ? aRes! : bRes!;
      if (actionable(firstRes)) {
        // Got changes/refetch from one shape; abort the other and return
        // immediately. Its rejection is already swallowed by the catch attached
        // above, so the abort can't surface as an unhandled rejection.
        (first === "a" ? ctlB : ctlA).abort();
        return first === "a"
          ? mergeParsedShapes(aRes!, unpolledShape("b", prior), prior)
          : mergeParsedShapes(unpolledShape("a", prior), bRes!, prior);
      }

      // First settled empty (idle timeout) — wait for the other.
      await (first === "a" ? pB : pA);
      return mergeParsedShapes(aRes!, bRes!, prior);
    } catch (error) {
      ctlA.abort();
      ctlB.abort();
      throw error;
    }
  }

  async #fetchShape(electricUrl: URL, signal?: AbortSignal): Promise<ParsedShape> {
    const resp = await longPollingFetch(electricUrl.toString(), { signal });
    const headers = {
      handle:
        resp.headers.get("electric-handle") ?? resp.headers.get("electric-shape-id") ?? undefined,
      offset:
        resp.headers.get("electric-offset") ??
        resp.headers.get("electric-chunk-last-offset") ??
        undefined,
      cursor: resp.headers.get("electric-cursor") ?? undefined,
      schema: resp.headers.get("electric-schema") ?? undefined,
    };
    if (resp.status >= 400) {
      try {
        await resp.body?.cancel();
      } catch {}
      return parseShapeMessages(resp.status, headers, "");
    }
    const bodyText = await resp.text();
    return parseShapeMessages(resp.status, headers, bodyText);
  }

  #buildMergeResponse(
    merged: MergedShape,
    isLive: boolean,
    apiVersion: API_VERSIONS,
    clientVersion?: string
  ): Response {
    const responseHeaders = new Headers();
    responseHeaders.set("content-type", "application/json");
    responseHeaders.set("cache-control", "no-store");
    // Match the native client: expose electric-* headers cross-origin or the
    // deployed react-hooks fail with MissingHeadersError.
    responseHeaders.set("access-control-allow-origin", "*");
    responseHeaders.set("access-control-expose-headers", "*");

    if (merged.mustRefetch) {
      // Reset the client's shape state; it refetches both tables from scratch.
      return new Response(JSON.stringify([MUST_REFETCH_MESSAGE, UP_TO_DATE_MESSAGE]), {
        status: 409,
        headers: responseHeaders,
      });
    }

    if (clientVersion) {
      responseHeaders.set("electric-handle", merged.handle);
      responseHeaders.set("electric-offset", merged.offset);
    } else {
      responseHeaders.set("electric-shape-id", merged.handle);
      responseHeaders.set("electric-chunk-last-offset", merged.offset);
    }
    if (isLive) {
      // The client requires electric-cursor on every live response (its live
      // cache-buster). Fall back to the offset if neither shape provided one.
      responseHeaders.set("electric-cursor", merged.cursor ?? merged.offset);
    } else if (merged.schema !== undefined) {
      // Non-live responses require electric-schema.
      responseHeaders.set("electric-schema", merged.schema);
    }

    const body = JSON.stringify([...merged.changes, UP_TO_DATE_MESSAGE]);
    const finalBody =
      apiVersion === CURRENT_API_VERSION ? body : this.#rewriteResponseBodyForNoneApiVersion(body);
    return new Response(finalBody, { status: 200, headers: responseHeaders });
  }

  #constructRunsElectricUrl(
    url: URL | string,
    environment: RealtimeEnvironment,
    whereClause: string,
    table: string,
    requestOptions?: RealtimeRequestOptions,
    clientVersion?: string
  ): URL {
    const $url = new URL(url.toString());

    const electricOrigin = this.#resolveElectricOrigin($url, whereClause, environment.id);
    const electricUrl = new URL(`${electricOrigin}/v1/shape`);

    // Copy over all the url search params to the electric url
    $url.searchParams.forEach((value, key) => {
      if (RESERVED_SEARCH_PARAMS.includes(key)) {
        return;
      }

      electricUrl.searchParams.set(key, value);
    });

    electricUrl.searchParams.set("where", whereClause);
    electricUrl.searchParams.set("table", table);

    if (!clientVersion) {
      // If the client version is not provided, that means we're using an older client
      // This means the client will be sending shape_id instead of handle
      electricUrl.searchParams.set("handle", electricUrl.searchParams.get("shape_id") ?? "");
    }

    let skipColumns = getSkipColumns($url.searchParams, requestOptions);

    if (skipColumns.length > 0) {
      skipColumns = skipColumns.filter((c) => c !== "" && !RESERVED_COLUMNS.includes(c));

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

  async #performElectricRequest(
    url: URL,
    environment: RealtimeEnvironment,
    apiVersion: API_VERSIONS,
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
      return this.#doLongPollingFetch(url, apiVersion, signal, rewriteResponseHeaders);
    }

    const isLive = isLiveRequestUrl(url);

    if (!isLive) {
      return this.#doLongPollingFetch(url, apiVersion, signal, rewriteResponseHeaders);
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
      const response = await this.#doLongPollingFetch(
        url,
        apiVersion,
        signal,
        rewriteResponseHeaders
      );

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

  async #doLongPollingFetch(
    url: URL,
    apiVersion: API_VERSIONS,
    signal?: AbortSignal,
    rewriteResponseHeaders?: Record<string, string>
  ) {
    if (apiVersion === CURRENT_API_VERSION) {
      return longPollingFetch(url.toString(), { signal }, rewriteResponseHeaders);
    }

    const response = await longPollingFetch(url.toString(), { signal }, rewriteResponseHeaders);

    return this.#rewriteResponseForNoneApiVersion(response);
  }

  async #rewriteResponseForNoneApiVersion(response: Response) {
    // Get the raw response body
    const responseBody = await response.text();

    // Rewrite the response body
    const rewrittenResponseBody = this.#rewriteResponseBodyForNoneApiVersion(responseBody);

    // Return the rewritten response
    return new Response(rewrittenResponseBody, {
      status: response.status,
      headers: response.headers,
    });
  }

  // Rewrites "status":"DEQUEUED" to "status":"EXECUTING"
  #rewriteResponseBodyForNoneApiVersion(responseBody: string) {
    return responseBody.replace(/"status":"DEQUEUED"/g, '"status":"EXECUTING"');
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

  #resolveElectricOrigin(url: URL, whereClause: string, environmentId: string) {
    if (typeof this.options.electricOrigin === "string") {
      return this.options.electricOrigin;
    }

    const shardKey = this.#getShardKey(whereClause, environmentId);

    const index = jumpHash(shardKey, this.options.electricOrigin.length);

    const origin = this.options.electricOrigin[index] ?? this.options.electricOrigin[0];

    logger.debug("[realtimeClient] resolveElectricOrigin", {
      whereClause,
      environmentId,
      shardKey,
      index,
      electricOrigin: origin,
    });

    return origin;
  }

  #getShardKey(whereClause: string, environmentId: string) {
    return [environmentId, whereClause].join(":");
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

function getSkipColumns(searchParams: URLSearchParams, requestOptions?: RealtimeRequestOptions) {
  if (requestOptions?.skipColumns) {
    return requestOptions.skipColumns;
  }

  const skipColumnsRaw = searchParams.get("skipColumns");

  if (skipColumnsRaw) {
    return skipColumnsRaw.split(",").map((c) => c.trim());
  }

  return [];
}
