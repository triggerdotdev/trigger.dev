import { Logger, LogLevel } from "@trigger.dev/core/logger";
import { createCache, DefaultStatefulContext, Namespace, Cache as UnkeyCache } from "@unkey/cache";
import { MemoryStore } from "@unkey/cache/stores";
import { RedisCacheStore } from "./unkey/redisCacheStore.server";
import { RedisWithClusterOptions } from "~/redis.server";
import { validate as uuidValidate, version as uuidVersion } from "uuid";
import { startActiveSpan } from "~/v3/tracer.server";

export type RequestIdempotencyServiceOptions<TTypes extends string> = {
  types: TTypes[];
  redis: RedisWithClusterOptions;
  logger?: Logger;
  logLevel?: LogLevel;
  ttlInMs?: number;
};

const DEFAULT_TTL_IN_MS = 60_000 * 60 * 24;

type RequestIdempotencyCacheEntry = {
  id: string;
};

export class RequestIdempotencyService<TTypes extends string> {
  private readonly logger: Logger;
  private readonly cache: UnkeyCache<{ requests: RequestIdempotencyCacheEntry }>;

  constructor(private readonly options: RequestIdempotencyServiceOptions<TTypes>) {
    this.logger =
      options.logger ?? new Logger("RequestIdempotencyService", options.logLevel ?? "info");

    const keyPrefix = options.redis.keyPrefix
      ? `request-idempotency:${options.redis.keyPrefix}`
      : "request-idempotency:";

    const ctx = new DefaultStatefulContext();
    const memory = new MemoryStore({ persistentMap: new Map() });
    const redisCacheStore = new RedisCacheStore({
      name: "request-idempotency",
      connection: {
        keyPrefix: keyPrefix,
        ...options.redis,
      },
    });

    // This cache holds the rate limit configuration for each org, so we don't have to fetch it every request
    const cache = createCache({
      requests: new Namespace<RequestIdempotencyCacheEntry>(ctx, {
        stores: [memory, redisCacheStore],
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

  // The requestIdempotencyKey should be a valid UUID
  #validateRequestId(requestIdempotencyKey: string): boolean {
    return isValidV4UUID(requestIdempotencyKey);
  }
}

function isValidV4UUID(uuid: string): boolean {
  return uuidValidate(uuid) && uuidVersion(uuid) === 4;
}
