import { CacheError } from "@unkey/cache";
import type { Entry, Store } from "@unkey/cache/stores";
import { Err, Ok, type Result } from "@unkey/error";
import { createRedisClient, RedisClient, RedisWithClusterOptions } from "~/redis.server";

export type RedisCacheStoreConfig = {
  connection: RedisWithClusterOptions;
};

export class RedisCacheStore<TNamespace extends string, TValue = any>
  implements Store<TNamespace, TValue>
{
  public readonly name = "redis";
  private readonly redis: RedisClient;

  constructor(config: RedisCacheStoreConfig) {
    this.redis = createRedisClient("trigger:cacheStore", config.connection);
  }

  private buildCacheKey(namespace: TNamespace, key: string): string {
    return [namespace, key].join("::");
  }

  public async get(
    namespace: TNamespace,
    key: string
  ): Promise<Result<Entry<TValue> | undefined, CacheError>> {
    let raw: string | null;
    try {
      raw = await this.redis.get(this.buildCacheKey(namespace, key));
    } catch (err) {
      return Err(
        new CacheError({
          tier: this.name,
          key,
          message: (err as Error).message,
        })
      );
    }

    if (!raw) {
      return Promise.resolve(Ok(undefined));
    }

    try {
      const superjson = await import("superjson");
      const entry = superjson.parse(raw) as Entry<TValue>;
      return Ok(entry);
    } catch (err) {
      return Err(
        new CacheError({
          tier: this.name,
          key,
          message: (err as Error).message,
        })
      );
    }
  }

  public async set(
    namespace: TNamespace,
    key: string,
    entry: Entry<TValue>
  ): Promise<Result<void, CacheError>> {
    const cacheKey = this.buildCacheKey(namespace, key);
    try {
      const superjson = await import("superjson");
      await this.redis.set(cacheKey, superjson.stringify(entry), "PXAT", entry.staleUntil);
      return Ok();
    } catch (err) {
      return Err(
        new CacheError({
          tier: this.name,
          key,
          message: (err as Error).message,
        })
      );
    }
  }

  public async remove(namespace: TNamespace, key: string): Promise<Result<void, CacheError>> {
    try {
      const cacheKey = this.buildCacheKey(namespace, key);
      await this.redis.del(cacheKey);
      return Promise.resolve(Ok());
    } catch (err) {
      return Err(
        new CacheError({
          tier: this.name,
          key,
          message: (err as Error).message,
        })
      );
    }
  }
}
