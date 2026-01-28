import { LRUCache } from "lru-cache";
import { CacheError } from "@unkey/cache";
import type { Store, Entry } from "@unkey/cache/stores";
import { Ok, Err, type Result } from "@unkey/error";

export type LRUMemoryStoreConfig = {
  /**
   * Maximum number of items to store in the cache.
   * This is a hard limit - the cache will never exceed this size.
   */
  max: number;

  /**
   * Name for metrics/tracing.
   * @default "lru-memory"
   */
  name?: string;
};

/**
 * A memory store implementation using lru-cache.
 *
 * This provides O(1) get/set/delete operations and automatic LRU eviction
 * without blocking the event loop (unlike @unkey/cache's MemoryStore which
 * uses O(n) synchronous iteration for eviction).
 *
 * TTL is checked lazily on get() - expired items are not proactively removed
 * but will be evicted by LRU when the cache is full.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class LRUMemoryStore<TNamespace extends string, TValue = any>
  implements Store<TNamespace, TValue>
{
  readonly name: string;
  private readonly cache: LRUCache<string, Entry<TValue>>;

  constructor(config: LRUMemoryStoreConfig) {
    this.name = config.name ?? "lru-memory";
    this.cache = new LRUCache<string, Entry<TValue>>({
      max: config.max,
      // Don't use ttlAutopurge - it creates a setTimeout per item which
      // doesn't scale well at high throughput (thousands of items/second).
      // Instead, we check TTL lazily on get().
      ttlAutopurge: false,
      // Allow returning stale values - the cache layer handles SWR semantics
      allowStale: true,
      // Use the staleUntil timestamp for TTL calculation
      ttl: 1, // Placeholder, we set per-item TTL in set()
    });
  }

  private buildCacheKey(namespace: TNamespace, key: string): string {
    return `${namespace}::${key}`;
  }

  async get(
    namespace: TNamespace,
    key: string
  ): Promise<Result<Entry<TValue> | undefined, CacheError>> {
    try {
      const cacheKey = this.buildCacheKey(namespace, key);
      const entry = this.cache.get(cacheKey);

      if (!entry) {
        return Ok(undefined);
      }

      // Check if entry is expired (past staleUntil)
      // The cache layer will handle fresh vs stale semantics
      if (entry.staleUntil <= Date.now()) {
        // Remove expired entry
        this.cache.delete(cacheKey);
        return Ok(undefined);
      }

      return Ok(entry);
    } catch (err) {
      return Err(
        new CacheError({
          tier: this.name,
          key,
          message: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }

  async set(
    namespace: TNamespace,
    key: string,
    entry: Entry<TValue>
  ): Promise<Result<void, CacheError>> {
    try {
      const cacheKey = this.buildCacheKey(namespace, key);

      // Calculate TTL from staleUntil timestamp
      const ttl = Math.max(0, entry.staleUntil - Date.now());

      this.cache.set(cacheKey, entry, { ttl });

      return Ok(undefined as void);
    } catch (err) {
      return Err(
        new CacheError({
          tier: this.name,
          key,
          message: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }

  async remove(
    namespace: TNamespace,
    keys: string | string[]
  ): Promise<Result<void, CacheError>> {
    try {
      const keyArray = Array.isArray(keys) ? keys : [keys];

      for (const key of keyArray) {
        const cacheKey = this.buildCacheKey(namespace, key);
        this.cache.delete(cacheKey);
      }

      return Ok(undefined as void);
    } catch (err) {
      return Err(
        new CacheError({
          tier: this.name,
          key: Array.isArray(keys) ? keys.join(",") : keys,
          message: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }

  /**
   * Returns the current number of items in the cache.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Clears all items from the cache.
   */
  clear(): void {
    this.cache.clear();
  }
}

/**
 * Creates an LRU memory store with the specified maximum size.
 *
 * This is a drop-in replacement for createMemoryStore() that uses lru-cache
 * instead of @unkey/cache's MemoryStore, providing:
 * - O(1) operations (vs O(n) eviction in MemoryStore)
 * - No event loop blocking
 * - Strict memory bounds (hard max vs soft cap)
 *
 * @param maxItems Maximum number of items to store
 * @param name Optional name for metrics/tracing (default: "lru-memory")
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createLRUMemoryStore(maxItems: number, name?: string): LRUMemoryStore<string, any> {
  return new LRUMemoryStore({ max: maxItems, name });
}
