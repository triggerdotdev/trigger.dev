import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { interpret as interpretHealth } from "./health/health";
import { loadHealthInput } from "./health/health-data";
import { type ReportViewModel } from "./report-view-model";

/** A query table a report may read. Same table names the query API authorizes against. */
export type ReportQueryTable = "runs" | "env_metrics" | "queue_metrics";

export type ReportLoader<TInput> = {
  /** Authorization metadata: the route derives its per-table JWT scope check from this. */
  tables: readonly ReportQueryTable[];
  load: (env: AuthenticatedEnvironment, period: string) => Promise<TInput>;
  interpret: (input: TInput) => ReportViewModel;
};

function defineReport<TInput>(loader: ReportLoader<TInput>): ReportLoader<unknown> {
  return loader as ReportLoader<unknown>;
}

export const REPORT_REGISTRY: Record<string, ReportLoader<unknown>> = {
  health: defineReport({
    tables: ["runs", "env_metrics", "queue_metrics"],
    load: (env, period) => loadHealthInput(env, period),
    interpret: interpretHealth,
  }),
};

export const REPORT_KEYS = Object.keys(REPORT_REGISTRY);

export function isReportKey(key: string): boolean {
  // Not `in`: it matches prototype keys like "toString", which would pass the route guard.
  return Object.hasOwn(REPORT_REGISTRY, key);
}

type ReportTablesRegistry = Record<string, Pick<ReportLoader<unknown>, "tables">>;

// An unknown key returns the union across every report, never an empty list, which would make
// the route's JWT scope check vacuous.
export function reportQueryTables(
  key: string,
  registry: ReportTablesRegistry = REPORT_REGISTRY
): readonly ReportQueryTable[] {
  if (Object.hasOwn(registry, key)) {
    return registry[key].tables;
  }

  const union = new Set<ReportQueryTable>();
  for (const report of Object.values(registry)) {
    for (const table of report.tables) {
      union.add(table);
    }
  }
  return [...union];
}
