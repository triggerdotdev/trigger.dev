import { SemanticInternalAttributes } from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";

export type CacheMetadata = {
  createdTime: number;
  ttl?: number | null;
};

export type CacheEntry<Value = unknown> = {
  metadata: CacheMetadata;
  value: Value;
};

export type Eventually<Value> = Value | null | undefined | Promise<Value | null | undefined>;

export type CacheStore<Value = any> = {
  name?: string;
  get: (key: string) => Eventually<CacheEntry<Value>>;
  set: (key: string, value: CacheEntry<Value>) => unknown | Promise<unknown>;
  delete: (key: string) => unknown | Promise<unknown>;
};

export type CacheFunction = <Value>(
  cacheKey: string,
  fn: () => Promise<Value> | Value
) => Promise<Value> | Value;

export class InMemoryCache<Value = any> {
  private _cache: Map<string, CacheEntry<Value>> = new Map();

  get(key: string): Eventually<CacheEntry<Value>> {
    return this._cache.get(key);
  }

  set(key: string, value: CacheEntry<Value>): unknown {
    this._cache.set(key, value);

    return undefined;
  }

  delete(key: string): unknown {
    this._cache.delete(key);

    return undefined;
  }
}

/**
 * Create a cache function that uses the provided store to cache values. Using InMemoryCache is safe because each task run is isolated.
 * @param store
 * @returns
 */
export function createCache(store: CacheStore): CacheFunction {
  return function cache<Value>(
    cacheKey: string,
    fn: () => Promise<Value> | Value
  ): Promise<Value> | Value {
    return tracer.startActiveSpan("cache", async (span) => {
      span.setAttribute("cache.key", cacheKey);
      span.setAttribute(SemanticInternalAttributes.STYLE_ICON, "device-sd-card");

      const cacheEntry = await store.get(cacheKey);

      if (cacheEntry) {
        span.updateName(`cache.hit ${cacheKey}`);

        return cacheEntry.value;
      }

      span.updateName(`cache.miss ${cacheKey}`);

      const value = await tracer.startActiveSpan(
        "cache.getFreshValue",
        async (span) => {
          return await fn();
        },
        {
          attributes: {
            "cache.key": cacheKey,
            [SemanticInternalAttributes.STYLE_ICON]: "device-sd-card",
          },
        }
      );

      await tracer.startActiveSpan(
        "cache.set",
        async (span) => {
          await store.set(cacheKey, {
            value,
            metadata: {
              createdTime: Date.now(),
            },
          });
        },
        {
          attributes: {
            "cache.key": cacheKey,
            [SemanticInternalAttributes.STYLE_ICON]: "device-sd-card",
          },
        }
      );

      return value;
    });
  };
}
