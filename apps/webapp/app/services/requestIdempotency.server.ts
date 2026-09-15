import type { LogLevel } from "@trigger.dev/core/logger";
import { Logger } from "@trigger.dev/core/logger";
import type { Cache as UnkeyCache } from "@unkey/cache";
import { createCache, DefaultStatefulContext, Namespace } from "@unkey/cache";
import { createLRUMemoryStore } from "@internal/cache";
import { RedisCacheStore } from "./unkey/redisCacheStore.server";
import type { RedisWithClusterOptions } from "~/redis.server";
import { startActiveSpan } from "~/v3/tracer.server";

export type RequestIdempotencyServiceOptions<TTypes extends string> = {
  types: TTypes[];
  redis?: RedisWithClusterOptions;
  logger?: Logger;
  logLevel?: LogLevel;
  ttlInMs?: number;
};

const DEFAULT_TTL_IN_MS = 60_000 * 60 * 24;

const SCOPED_REQUEST_ID_REGEX = /^[0-9a-f]{64}$/;

type RequestIdempotencyCacheEntry = {
  id: string;
};

export class RequestIdempotencyService<TTypes extends string> {
  private readonly logger: Logger;
  private readonly cache: UnkeyCache<{ requests: RequestIdempotencyCacheEntry }>;

  constructor(private readonly options: RequestIdempotencyServiceOptions<TTypes>) {
    this.logger =
      options.logger ?? new Logger("RequestIdempotencyService", options.logLevel ?? "info");

    const ctx = new DefaultStatefulContext();
    const memory = createLRUMemoryStore(1000);
    const redisCacheStore = options.redis
      ? new RedisCacheStore({
          name: "request-idempotency",
          connection: {
            keyPrefix: options.redis.keyPrefix
              ? `request-idempotency:${options.redis.keyPrefix}`
              : "request-idempotency:",
            ...options.redis,
          },
        })
      : undefined;

    // This cache holds the rate limit configuration for each org, so we don't have to fetch it every request
    const cache = createCache({
      requests: new Namespace<RequestIdempotencyCacheEntry>(ctx, {
        stores: redisCacheStore ? [memory, redisCacheStore] : [memory],
        fresh: options.ttlInMs ?? DEFAULT_TTL_IN_MS,
        stale: options.ttlInMs ?? DEFAULT_TTL_IN_MS,
      }),
    });

    this.cache = cache;
  }

  async checkRequest(type: TTypes, requestIdempotencyKey: string) {
    if (!this.#validateRequestId(requestIdempotencyKey)) {
      this.logger.warn("RequestIdempotency: invalid requestIdempotencyKey", {
        requestIdempotencyKey,
      });

      return undefined;
    }

    return startActiveSpan("RequestIdempotency.checkRequest()", async (span) => {
      span.setAttribute("request_id", requestIdempotencyKey);
      span.setAttribute("type", type);

      const key = `${type}:${requestIdempotencyKey}`;
      const result = await this.cache.requests.get(key);

      this.logger.debug("RequestIdempotency: checking request", {
        type,
        requestIdempotencyKey,
        key,
        result,
      });

      return result.val ? result.val : undefined;
    });
  }

  async saveRequest(
    type: TTypes,
    requestIdempotencyKey: string,
    value: RequestIdempotencyCacheEntry
  ) {
    if (!this.#validateRequestId(requestIdempotencyKey)) {
      this.logger.warn("RequestIdempotency: invalid requestIdempotencyKey", {
        requestIdempotencyKey,
      });
      return undefined;
    }

    const key = `${type}:${requestIdempotencyKey}`;
    const result = await this.cache.requests.set(key, value);

    if (result.err) {
      this.logger.error("RequestIdempotency: error saving request", {
        key,
        error: result.err,
      });
    } else {
      this.logger.debug("RequestIdempotency: saved request", {
        type,
        requestIdempotencyKey,
        key,
        value,
      });
    }

    return result;
  }

  // Keys are server-derived by `scopeRequestIdempotencyKey()`, so only the shape needs checking.
  #validateRequestId(requestIdempotencyKey: string): boolean {
    return SCOPED_REQUEST_ID_REGEX.test(requestIdempotencyKey);
  }
}
