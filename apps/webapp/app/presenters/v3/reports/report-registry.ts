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

/**
 * Input to the route's JWT scope check. An unknown key declares no tables: `checkAuth` denies an
 * empty `everyResource`, so a bad key authorizes nothing rather than everything.
 */
export function reportQueryTables(
  key: string,
  registry: ReportTablesRegistry = REPORT_REGISTRY
): readonly ReportQueryTable[] {
  return Object.hasOwn(registry, key) ? registry[key].tables : [];
}
