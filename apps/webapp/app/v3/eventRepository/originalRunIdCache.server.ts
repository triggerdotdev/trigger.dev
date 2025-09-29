import {
  createCache,
  DefaultStatefulContext,
  Namespace,
  RedisCacheStore,
  type UnkeyCache,
} from "@internal/cache";
import type { RedisOptions } from "@internal/redis";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";

export type OriginalRunIdCacheOptions = {
  redisOptions: RedisOptions;
};

const ORIGINAL_RUN_ID_FRESH_TTL = 60000 * 60 * 24 * 30; // 30 days
const ORIGINAL_RUN_ID_STALE_TTL = 60000 * 60 * 24 * 31; // 31 days

export class OriginalRunIdCache {
  private readonly cache: UnkeyCache<{
    originalRunId: string;
  }>;

  constructor(options: OriginalRunIdCacheOptions) {
    // Initialize cache
    const ctx = new DefaultStatefulContext();
    const redisCacheStore = new RedisCacheStore({
      name: "original-run-id-cache",
      connection: {
        ...options.redisOptions,
        keyPrefix: "original-run-id-cache:",
      },
      useModernCacheKeyBuilder: true,
    });

    this.cache = createCache({
      originalRunId: new Namespace<string>(ctx, {
        stores: [redisCacheStore],
        fresh: ORIGINAL_RUN_ID_FRESH_TTL,
        stale: ORIGINAL_RUN_ID_STALE_TTL,
      }),
    });
  }

  public async lookup(traceId: string, spanId: string) {
    const result = await this.cache.originalRunId.get(`${traceId}:${spanId}`);

    return result.val;
  }

  public async set(traceId: string, spanId: string, originalRunId: string) {
    await this.cache.originalRunId.set(`${traceId}:${spanId}`, originalRunId);
  }

  public async swr(traceId: string, spanId: string, callback: () => Promise<string | undefined>) {
    const result = await this.cache.originalRunId.swr(`${traceId}:${spanId}`, callback);

    return result.val;
  }
}

export const originalRunIdCache = singleton(
  "originalRunIdCache",
  () =>
    new OriginalRunIdCache({
      redisOptions: {
        port: env.REDIS_PORT ?? undefined,
        host: env.REDIS_HOST ?? undefined,
        username: env.REDIS_USERNAME ?? undefined,
        password: env.REDIS_PASSWORD ?? undefined,
        enableAutoPipelining: true,
        ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
      },
    })
);
