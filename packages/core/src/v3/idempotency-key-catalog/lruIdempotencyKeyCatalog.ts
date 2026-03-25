import type { IdempotencyKeyCatalog, IdempotencyKeyOptions } from "./catalog.js";

export class LRUIdempotencyKeyCatalog implements IdempotencyKeyCatalog {
  private cache: Map<string, IdempotencyKeyOptions>;
  private readonly maxSize: number;

  constructor(maxSize: number = 1_000) {
    this.cache = new Map();
    // Clamp to non-negative to prevent infinite loop in eviction
    this.maxSize = Math.max(0, maxSize);
  }

  registerKeyOptions(hash: string, options: IdempotencyKeyOptions): void {
    // Delete and re-add to update position (most recently used)
    this.cache.delete(hash);
    this.cache.set(hash, options);

    // Evict oldest entries if over capacity
    while (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }

  getKeyOptions(hash: string): IdempotencyKeyOptions | undefined {
    const options = this.cache.get(hash);
    if (options) {
      // Move to end (most recently used)
      this.cache.delete(hash);
      this.cache.set(hash, options);
    }
    return options;
  }
}
