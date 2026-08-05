/**
 * Load, interpret, return the generic ReportViewModel. No SQL or rendering here: data access lives
 * in each report's `load`, meaning in `interpret`, presentation in the renderers.
 *
 * `call` takes a resolved AuthenticatedEnvironment and is transport-independent, so any new surface
 * is just another caller of it.
 */

import {
  createCache,
  createLRUMemoryStore,
  DefaultStatefulContext,
  Namespace,
  type UnkeyCache,
} from "@internal/cache";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { REPORT_REGISTRY, type ReportLoader } from "./report-registry";
import { type ReportViewModel } from "./report-view-model";

const DEFAULT_PERIOD = "1h";

/**
 * How long a finished report stays reusable. A report costs about nine ClickHouse queries, and its
 * dominant callers are periodic: every watch tick in an environment asks for the same health
 * verdict. 90s sits under the tick cadence but well over a burst, so a burst pays once. It stays
 * short because a health verdict drives what the agent tells the user.
 */
export const REPORT_CACHE_TTL_MS = 90_000;

/** How many report, environment and period triples one instance keeps. */
const REPORT_CACHE_MAX_ENTRIES = 500;

export type ReportCache = UnkeyCache<{ report: ReportViewModel }>;

/**
 * In-process only. An entry is a whole rendered report, so a shared store would put the full
 * payload on the Redis hot path for the entry's lifetime, and per-instance caching already wins
 * most of the saving. `stale` equals `fresh`, so nothing past the window is ever served.
 */
export function createReportCache(ttlMs: number = REPORT_CACHE_TTL_MS): ReportCache {
  return createCache({
    report: new Namespace<ReportViewModel>(new DefaultStatefulContext(), {
      stores: [createLRUMemoryStore(REPORT_CACHE_MAX_ENTRIES)],
      fresh: ttlMs,
      stale: ttlMs,
    }),
  });
}

const defaultReportCache = createReportCache();

/**
 * Collapses concurrent identical requests into one computation, so N callers don't each launch the
 * full query set and pile onto the per-project query-concurrency limit. This is needed alongside
 * the cache, which only helps once something has finished: the first callers of a cold key all miss
 * at the same moment. A rejected load is never cached, so the next caller retries.
 */
const inFlight = new Map<string, Promise<ReportViewModel | undefined>>();

export class ReportPresenter {
  constructor(
    private readonly registry: Record<string, ReportLoader<unknown>> = REPORT_REGISTRY,
    // Injectable so a test gets its own window. The default is shared because the callers that
    // benefit each construct their own presenter.
    private readonly cache: ReportCache = defaultReportCache
  ) {}

  async call({
    environment,
    key,
    period = DEFAULT_PERIOD,
  }: {
    environment: AuthenticatedEnvironment;
    key: string;
    period?: string;
  }): Promise<ReportViewModel | undefined> {
    if (!Object.hasOwn(this.registry, key)) return undefined;
    const loader = this.registry[key];

    // The environment id is part of the key, so one environment can never read another's report.
    const flightKey = `${key} ${environment.id} ${period}`;

    const cached = await this.cache.report.get(flightKey);
    if (cached.val) return cached.val;

    const existing = inFlight.get(flightKey);
    if (existing) return existing;

    const promise = (async () => {
      const input = await loader.load(environment, period);
      const report = loader.interpret(input);
      await this.cache.report.set(flightKey, report);
      return report;
    })().finally(() => inFlight.delete(flightKey));

    inFlight.set(flightKey, promise);
    return promise;
  }
}
