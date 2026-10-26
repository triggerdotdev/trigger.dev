export type QueryMode = "threshold" | "absence" | "match";

export type QuerySource = {
  table: string;
  timeColumns: { threshold: string; match?: string };
  eventTime: { threshold: boolean; match?: boolean };
  stableId?: string;
  modes: QueryMode[];
  scope: "environment";
  minCadenceSec: number;
  flag?: string;
};

export const QUERY_SOURCES: Record<string, QuerySource> = {
  runs: {
    table: "runs",
    timeColumns: { threshold: "triggered_at", match: "completed_at" },
    eventTime: { threshold: false, match: true },
    stableId: "run_id",
    modes: ["threshold", "absence", "match"],
    scope: "environment",
    minCadenceSec: 600,
  },
  error_occurrences: {
    table: "error_occurrences",
    timeColumns: { threshold: "minute" },
    eventTime: { threshold: true },
    modes: ["threshold", "absence"],
    scope: "environment",
    minCadenceSec: 300,
  },
  errors: {
    table: "errors",
    timeColumns: { threshold: "last_seen" },
    eventTime: { threshold: false },
    modes: ["threshold"],
    scope: "environment",
    minCadenceSec: 300,
  },
  llm_metrics: {
    table: "llm_metrics",
    timeColumns: { threshold: "start_time", match: "start_time" },
    eventTime: { threshold: true, match: true },
    stableId: "span_id",
    modes: ["threshold", "match"],
    scope: "environment",
    minCadenceSec: 300,
  },
  metrics: {
    table: "metrics",
    timeColumns: { threshold: "bucket_start" },
    eventTime: { threshold: false },
    modes: ["threshold"],
    scope: "environment",
    minCadenceSec: 300,
  },
  concurrency_metrics: {
    table: "concurrency_metrics",
    timeColumns: { threshold: "bucket_start" },
    eventTime: { threshold: false },
    modes: ["threshold"],
    scope: "environment",
    minCadenceSec: 300,
    flag: "QUEUE_METRICS",
  },
  env_metrics: {
    table: "env_metrics",
    timeColumns: { threshold: "bucket_start" },
    eventTime: { threshold: false },
    modes: ["threshold"],
    scope: "environment",
    minCadenceSec: 300,
    flag: "QUEUE_METRICS",
  },
};

export function getQuerySource(table: string | undefined): QuerySource | undefined {
  return table ? Object.values(QUERY_SOURCES).find((s) => s.table === table) : undefined;
}

export function querySourcesFor(tables: string[]): QuerySource[] {
  return tables.flatMap((t) => getQuerySource(t) ?? []);
}

function knownSources(tables: string[]): QuerySource[] | undefined {
  const sources = querySourcesFor(tables);
  return sources.length === tables.length ? sources : undefined;
}

/** Undefined when any table is unknown or the list is empty. */
export function minCadenceForTables(tables: string[]): number | undefined {
  const sources = knownSources(tables);
  return sources?.length ? Math.max(...sources.map((s) => s.minCadenceSec)) : undefined;
}

/** Empty when any table is unknown. */
export function modesForTables(tables: string[]): QueryMode[] {
  const sources = knownSources(tables);
  if (!sources?.length) return [];
  const matchable = sources.some((s) => s.modes.includes("match") && !!s.stableId);
  return (["threshold", "absence", "match"] as const).filter((mode) =>
    mode === "match" ? matchable : sources.every((s) => s.modes.includes(mode))
  );
}
