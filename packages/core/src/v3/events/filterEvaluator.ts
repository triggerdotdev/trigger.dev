import type { EventFilter } from "../schemas/eventFilter.js";
import { eventFilterMatches } from "../../eventFilterMatches.js";

type CompiledFilter = (payload: unknown) => boolean;

const filterCache = new Map<string, CompiledFilter>();
const FILTER_CACHE_MAX = 1000;

/**
 * Compile an EventFilter into a reusable predicate function.
 * The compiled function is cached by the given cacheKey (typically a subscription ID).
 *
 * Uses the existing, battle-tested `eventFilterMatches` under the hood.
 */
export function compileFilter(filter: EventFilter, cacheKey?: string): CompiledFilter {
  if (cacheKey) {
    const cached = filterCache.get(cacheKey);
    if (cached) return cached;
  }

  const fn: CompiledFilter = (payload: unknown) => eventFilterMatches(payload, filter);

  if (cacheKey) {
    if (filterCache.size >= FILTER_CACHE_MAX) {
      const toDelete = Math.floor(FILTER_CACHE_MAX / 2);
      let i = 0;
      for (const key of filterCache.keys()) {
        if (i++ >= toDelete) break;
        filterCache.delete(key);
      }
    }
    filterCache.set(cacheKey, fn);
  }

  return fn;
}

/**
 * Evaluate a filter against a payload (one-shot, no caching).
 */
export function evaluateFilter(payload: unknown, filter: EventFilter): boolean {
  return eventFilterMatches(payload, filter);
}

/**
 * Invalidate a cached compiled filter (e.g., on re-deploy).
 */
export function invalidateFilterCache(cacheKey: string): void {
  filterCache.delete(cacheKey);
}

/**
 * Clear all cached compiled filters.
 */
export function clearFilterCache(): void {
  filterCache.clear();
}
