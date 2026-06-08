/**
 * Tiny in-process bounded TTL cache shared by the realtime feeds.
 *
 * Entries expire after `ttlMs`. An expired entry is evicted when read (`get`); on
 * write, if the cache is at `maxEntries`, expired entries are swept and, if it's
 * still full (pathologically all live), the oldest insertion is dropped. Node is
 * single-threaded so no locking is needed. Used where a miss is cheap and
 * correctness-safe (read-through hydration, per-handle working sets, per-org flag
 * resolution).
 *
 * A stored value of `undefined` cannot be distinguished from a miss; callers that
 * need to cache "absence" should store an explicit sentinel (e.g. `null`).
 */
export class BoundedTtlCache<V> {
  readonly #entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number
  ) {}

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt > Date.now()) {
      return entry.value;
    }
    // Evict on read so expired entries don't linger until the next at-capacity
    // sweep — important for read-heavy / low-churn caches (per-handle working sets).
    this.#entries.delete(key);
    return undefined;
  }

  set(key: string, value: V): void {
    if (this.#entries.size >= this.maxEntries) {
      const now = Date.now();
      for (const [key, entry] of this.#entries) {
        if (entry.expiresAt <= now) {
          this.#entries.delete(key);
        }
      }
      if (this.#entries.size >= this.maxEntries) {
        const oldest = this.#entries.keys().next().value;
        if (oldest !== undefined) {
          this.#entries.delete(oldest);
        }
      }
    }
    this.#entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  get size(): number {
    return this.#entries.size;
  }
}
