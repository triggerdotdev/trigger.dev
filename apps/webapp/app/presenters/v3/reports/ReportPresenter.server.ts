/**
 * Thin orchestrator: load -> interpret -> return the generic ReportViewModel. No SQL or render
 * here — data access lives in each report's `load`, meaning in `interpret`, presentation in the
 * renderers, and the catalog of reports in `report-registry.ts`.
 *
 * `call` takes a resolved AuthenticatedEnvironment and is transport-independent (Seam B, §7):
 * any future surface (MCP Resource, etc.) is just another caller of this same method.
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
 * How long a finished report stays reusable. A report costs ~9 ClickHouse queries, and the
 * callers that dominate its volume are periodic, not interactive: every watch tick in an
 * environment asks for the same health verdict, so a sweep over N watches recomputed it N
 * times. 90s is under the tick cadence but well over a burst, so the burst pays once.
 *
 * The window is deliberately short — a health verdict drives what the agent tells the user, so
 * it may lag by a cadence but never by minutes.
 */
export const REPORT_CACHE_TTL_MS = 90_000;

/** How many (report, environment, period) triples one instance keeps. */
const REPORT_CACHE_MAX_ENTRIES = 500;

export type ReportCache = UnkeyCache<{ report: ReportViewModel }>;

/**
 * In-process only. Each webapp instance caches on its own, which is the right trade here: the
 * entry is a whole rendered report, the saving is already most of the win per instance, and a
 * shared store would put a report's full payload on the Redis hot path for a 90s lifetime.
 *
 * `stale` equals `fresh`, so this is a plain TTL — nothing past the window is ever served.
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
 * Single-flight: collapse concurrent identical requests (same report/env/period) into one
 * computation. A report fires up to ~9 ClickHouse queries and MCP/CLI clients easily call it
 * several times at once — without this, N callers each launch the full query set and pile onto
 * the per-project query-concurrency limit. Keyed per (key, env, period); entry drops on settle.
 *
 * Still needed alongside the cache: a cache only helps once something has finished, so the
 * first callers of a cold key all miss at the same moment and it's this map that keeps them to
 * one load. A rejected load is never cached, so the next caller retries.
 */
const inFlight = new Map<string, Promise<ReportViewModel | undefined>>();

export class ReportPresenter {
  constructor(
    private readonly registry: Record<string, ReportLoader<unknown>> = REPORT_REGISTRY,
    // Injectable so a test gets its own window; the default is shared, because the callers that
    // benefit (the watch ticks) each construct their own presenter.
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

    // The environment id is part of the key, so one environment can never read another's
    // report — the same property the single-flight key relies on.
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
