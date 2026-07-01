import type { IdempotencyKeyCatalog, IdempotencyKeyOptions } from "./catalog.js";

/**
 * Maps an idempotency-key hash back to the original user-provided key and scope.
 *
 * The mapping is held for the lifetime of a single run: the worker clears it at
 * each run boundary (warm starts reuse the process), so it never accumulates
 * across runs. Within a run every registered key is retained regardless of how
 * many are created, so the key/scope metadata is never silently dropped.
 */
export class InMemoryIdempotencyKeyCatalog implements IdempotencyKeyCatalog {
  private cache = new Map<string, IdempotencyKeyOptions>();

  registerKeyOptions(hash: string, options: IdempotencyKeyOptions): void {
    this.cache.set(hash, options);
  }

  getKeyOptions(hash: string): IdempotencyKeyOptions | undefined {
    return this.cache.get(hash);
  }

  clear(): void {
    this.cache.clear();
  }
}
