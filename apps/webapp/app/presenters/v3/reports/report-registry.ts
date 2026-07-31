/**
 * The report catalog: which reports exist, what data each is allowed to read, and how each
 * loads + interprets it. Keyed by report name so cost/regression/errors drop in later as new
 * `{ tables, load, interpret }` entries with no changes to the VM, renderers, route, tool, or
 * presenter.
 *
 * Deliberately separate from `ReportPresenter` — the presenter only orchestrates (look up a
 * loader by key, run it, single-flight); knowing WHICH reports exist is a distinct concern.
 */

import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { interpret as interpretHealth } from "./health/health";
import { loadHealthInput } from "./health/health-data";
import { type ReportViewModel } from "./report-view-model";

/** A query table a report may read. Same table names the query API authorizes against. */
export type ReportQueryTable = "runs" | "env_metrics" | "queue_metrics";

export type ReportLoader<TInput> = {
  /**
   * The query tables this report reads. This is authorization metadata, not documentation: the
   * route derives its per-table JWT scope check from it, so a new report with narrower data
   * needs only its own entry here — no route change.
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
  // Object.hasOwn, not `in`: `in` matches prototype keys ("toString", "__proto__"),
  // which would pass the route guard and then 500 in the loader.
  return Object.hasOwn(REPORT_REGISTRY, key);
}

/** Only the `tables` field matters for scope derivation, so tests can pass a stub registry. */
type ReportTablesRegistry = Record<string, Pick<ReportLoader<unknown>, "tables">>;

/**
 * The query tables a request for `key` will read — the input to the route's JWT scope check.
 *
 * An unknown key returns the union across every report rather than an empty list: empty would
 * make the check vacuous, and a single table would be arbitrary. The union is the strictest
 * answer that still lets a fully-scoped token through to the handler's 404 (so a bad key reads
 * as "no such report", not "forbidden").
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
