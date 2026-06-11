/**
 * Tiny in-process bounded TTL cache shared by the realtime feeds: entries expire after `ttlMs` (evicted on read),
 * and at-capacity writes sweep expired entries then drop the oldest. A stored `undefined` is indistinguishable from a miss (use `null` for absence).
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
    // Only run capacity eviction when inserting a NEW key — updating an existing key
    // doesn't grow the map, so it must never drop an unrelated live entry.
    if (!this.#entries.has(key) && this.#entries.size >= this.maxEntries) {
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
