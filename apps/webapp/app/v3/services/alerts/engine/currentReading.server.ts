import type { Alert } from "../storage/alertStore.server";
import { getCapability } from "@internal/alert-contracts";
import type { EvaluateBindingFn, BindingResult } from "./evaluateAlert.server";

export type CurrentReading =
  | { status: "available"; result: BindingResult["result"]; observedAt: Date }
  | { status: "unavailable"; observedAt: Date; lastError?: string };

const DEFAULT_CACHE_TTL_MS = 30_000;
// Well past any realistic TTL, so a stale entry never lingers past a page reload cycle.
const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_MAX_SIZE = 500;

/**
 * Detail page "what does the capability see right now" read. Re-runs the same
 * production dispatcher the tick uses, but never calls applyEvaluationOutcome --
 * nothing is persisted. Cached per alert id so repeated page loads don't re-hit
 * ClickHouse/Postgres inside the TTL.
 */
export interface CurrentReadingCache {
  get(alertId: string): { at: number; value: CurrentReading } | undefined;
  set(alertId: string, entry: { at: number; value: CurrentReading }): void;
  size(): number;
}

export interface InMemoryCurrentReadingCacheOptions {
  maxSize?: number;
  maxAgeMs?: number;
}

/**
 * Bounded so a stream of distinct alert ids (or a long-lived worker process)
 * can't grow this without limit: every `set` first drops entries older than
 * `maxAgeMs`, then evicts the oldest (insertion order) until under `maxSize`.
 */
export function createInMemoryCurrentReadingCache(
  options: InMemoryCurrentReadingCacheOptions = {}
): CurrentReadingCache {
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const store = new Map<string, { at: number; value: CurrentReading }>();

  return {
    get: (alertId) => store.get(alertId),
    size: () => store.size,
    set: (alertId, entry) => {
      for (const [key, existing] of store) {
        if (entry.at - existing.at > maxAgeMs) {
          store.delete(key);
        }
      }

      store.delete(alertId);
      store.set(alertId, entry);

      while (store.size > maxSize) {
        const oldestKey = store.keys().next().value;
        if (oldestKey === undefined) break;
        store.delete(oldestKey);
      }
    },
  };
}

const defaultCache = createInMemoryCurrentReadingCache();

export interface GetCurrentReadingDeps {
  evaluateBinding: EvaluateBindingFn;
  cache?: CurrentReadingCache;
  cacheTtlMs?: number;
  now?: () => Date;
}

export async function getCurrentReading(
  alert: Alert,
  deps: GetCurrentReadingDeps
): Promise<CurrentReading> {
  const now = deps.now ?? (() => new Date());
  const cache = deps.cache ?? defaultCache;
  const ttlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  const nowDate = now();
  const cached = cache.get(alert.id);
  if (cached && nowDate.getTime() - cached.at < ttlMs) {
    return cached.value;
  }

  const capability = getCapability(alert.capabilityKey);
  if (!capability) {
    const value: CurrentReading = { status: "unavailable", observedAt: nowDate };
    cache.set(alert.id, { at: nowDate.getTime(), value });
    return value;
  }

  let value: CurrentReading;
  try {
    const { result } = await deps.evaluateBinding(alert, capability);
    value = { status: "available", result, observedAt: nowDate };
  } catch (error) {
    value = {
      status: "unavailable",
      observedAt: nowDate,
      lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    };
  }

  cache.set(alert.id, { at: nowDate.getTime(), value });
  return value;
}
