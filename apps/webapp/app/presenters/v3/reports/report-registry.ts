/**
 * The report catalog: which reports exist, what data each may read, and how each loads and
 * interprets it. A new report is a new `{ tables, load, interpret }` entry with no changes to the
 * view model, renderers, route or presenter.
 */

import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { interpret as interpretHealth } from "./health/health";
import { loadHealthInput } from "./health/health-data";
import { type ReportViewModel } from "./report-view-model";

/** A query table a report may read. Same table names the query API authorizes against. */
export type ReportQueryTable = "runs" | "env_metrics" | "queue_metrics";

export type ReportLoader<TInput> = {
  /**
   * The query tables this report reads. Authorization metadata, not documentation: the route
   * derives its per-table JWT scope check from it, so a narrower report needs no route change.
   */
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
  // Object.hasOwn rather than `in`: `in` matches prototype keys like "toString", which would pass
  // the route guard and then 500 in the loader.
  return Object.hasOwn(REPORT_REGISTRY, key);
}

/** Only the `tables` field matters for scope derivation, so tests can pass a stub registry. */
type ReportTablesRegistry = Record<string, Pick<ReportLoader<unknown>, "tables">>;

/**
 * The query tables a request for `key` will read, and the input to the route's JWT scope check.
 *
 * An unknown key returns the union across every report, not an empty list, which would make the
 * check vacuous. The union is the strictest answer that still lets a fully-scoped token reach the
 * handler's 404, so a bad key reads as "no such report" rather than "forbidden".
 */
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
