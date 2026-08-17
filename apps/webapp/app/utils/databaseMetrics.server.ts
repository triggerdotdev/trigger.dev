import { singleton } from "./singleton";

export type MetricHistogramValue = {
  buckets: [number, number][];
  sum: number;
  count: number;
};

type PrismaMetricsJson = {
  counters: Array<{ key: string; value: number }>;
  gauges: Array<{ key: string; value: number }>;
  histograms: Array<{ key: string; value: MetricHistogramValue }>;
};

type MetricsCapableClient = {
  $metrics: { json: () => Promise<PrismaMetricsJson> };
};

type PoolLike = {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
};

export type DatabaseMetricsSource = {
  clientType: string;
  usesDriverAdapter: boolean;
  client: MetricsCapableClient;
  pool?: PoolLike;
  poolCounters?: { opened: () => number; closed: () => number };
};

type NormalizedPoolMetrics = {
  open: number;
  busy: number;
  idle: number;
  waiting: number;
  openedTotal: number;
  closedTotal: number;
};

export type NormalizedDatabaseMetrics = {
  clientType: string;
  driver: "pg-adapter" | "quaint";
  engineMetricsAvailable: boolean;
  pool?: NormalizedPoolMetrics;
  counters?: { queriesTotal: number; datasourceQueriesTotal: number };
  gauges?: { queriesActive: number; queriesWait: number };
  histograms: {
    queriesWait?: MetricHistogramValue;
    queriesDuration?: MetricHistogramValue;
    datasourceQueriesDuration?: MetricHistogramValue;
  };
};

const sources = singleton("databaseMetricsSources", () => new Map<string, DatabaseMetricsSource>());

export function registerDatabaseMetricsSource(source: DatabaseMetricsSource): void {
  sources.set(source.clientType, source);
}

function listDatabaseMetricsSources(): ReadonlyArray<DatabaseMetricsSource> {
  return Array.from(sources.values());
}

function resetDatabaseMetricsSources(): void {
  sources.clear();
}

function indexByKey(entries: Array<{ key: string; value: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of entries) {
    out[entry.key] = entry.value;
  }
  return out;
}

export function normalizeDatabaseMetrics(
  source: DatabaseMetricsSource,
  json: PrismaMetricsJson | undefined
): NormalizedDatabaseMetrics {
  const driver = source.usesDriverAdapter ? ("pg-adapter" as const) : ("quaint" as const);
  const counters = json ? indexByKey(json.counters) : undefined;
  const gauges = json ? indexByKey(json.gauges) : undefined;

  let pool: NormalizedPoolMetrics | undefined;
  if (source.usesDriverAdapter && source.pool) {
    const total = source.pool.totalCount;
    const idle = source.pool.idleCount;
    pool = {
      open: total,
      idle,
      busy: Math.max(0, total - idle),
      waiting: source.pool.waitingCount,
      openedTotal: source.poolCounters?.opened() ?? 0,
      closedTotal: source.poolCounters?.closed() ?? 0,
    };
  } else if (counters && gauges) {
    pool = {
      open: gauges["prisma_pool_connections_open"] ?? 0,
      busy: gauges["prisma_pool_connections_busy"] ?? 0,
      idle: gauges["prisma_pool_connections_idle"] ?? 0,
      waiting: 0,
      openedTotal: counters["prisma_pool_connections_opened_total"] ?? 0,
      closedTotal: counters["prisma_pool_connections_closed_total"] ?? 0,
    };
  }

  const result: NormalizedDatabaseMetrics = {
    clientType: source.clientType,
    driver,
    engineMetricsAvailable: json !== undefined,
    pool,
    histograms: {},
  };

  if (json && counters && gauges) {
    const histograms: Record<string, MetricHistogramValue> = {};
    for (const histogram of json.histograms) {
      histograms[histogram.key] = histogram.value;
    }
    result.counters = {
      queriesTotal: counters["prisma_client_queries_total"] ?? 0,
      datasourceQueriesTotal: counters["prisma_datasource_queries_total"] ?? 0,
    };
    result.gauges = {
      queriesActive: gauges["prisma_client_queries_active"] ?? 0,
      queriesWait: gauges["prisma_client_queries_wait"] ?? 0,
    };
    result.histograms = {
      queriesWait: histograms["prisma_client_queries_wait_histogram_ms"],
      queriesDuration: histograms["prisma_client_queries_duration_histogram_ms"],
      datasourceQueriesDuration: histograms["prisma_datasource_queries_duration_histogram_ms"],
    };
  }

  return result;
}

export async function collectDatabaseClientMetrics(): Promise<NormalizedDatabaseMetrics[]> {
  return Promise.all(
    Array.from(sources.values()).map(async (source) => {
      let json: PrismaMetricsJson | undefined;
      try {
        json = await source.client.$metrics.json();
      } catch {
        json = undefined;
      }
      return normalizeDatabaseMetrics(source, json);
    })
  );
}
