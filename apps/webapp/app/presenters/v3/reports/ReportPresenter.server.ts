import {
  createCache,
  createLRUMemoryStore,
  DefaultStatefulContext,
  Namespace,
  type UnkeyCache,
} from "@internal/cache";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { HEALTH_THRESHOLDS } from "./health/health-core";
import { REPORT_REGISTRY, type ReportLoader } from "./report-registry";
import { type ReportViewModel } from "./report-view-model";

const DEFAULT_PERIOD = "1h";

/**
 * How long a finished report stays reusable. Capped at the liveness fresh window so a
 * cached report can never render "fresh" while its telemetry is already stale, and it
 * stays under the watch tick cadence.
 */
export const REPORT_CACHE_TTL_MS = HEALTH_THRESHOLDS.liveness.freshMs;

/** How many report, environment and period triples one instance keeps. */
const REPORT_CACHE_MAX_ENTRIES = 500;

export type ReportCache = UnkeyCache<{ report: ReportViewModel }>;

/** In-process only: an entry is a whole report. `stale` equals `fresh`, so nothing stale is served. */
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
 * Collapses concurrent identical requests into one computation: the cache only helps once a load has
 * finished, so all callers of a cold key would otherwise hit the query-concurrency limit at once.
 */
const inFlight = new Map<string, Promise<ReportViewModel | undefined>>();

export class ReportPresenter {
  constructor(
    private readonly registry: Record<string, ReportLoader<unknown>> = REPORT_REGISTRY,
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
