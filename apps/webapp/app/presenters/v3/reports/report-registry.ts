/**
 * The report catalog: which reports exist and how each loads + interprets its data. Keyed by
 * report name so cost/regression/errors drop in later as new `{ load, interpret }` entries with
 * no changes to the VM, renderers, route, tool, or presenter.
 *
 * Deliberately separate from `ReportPresenter` — the presenter only orchestrates (look up a
 * loader by key, run it, single-flight); knowing WHICH reports exist is a distinct concern.
 */

import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { interpret as interpretHealth } from "./health/health";
import { loadHealthInput } from "./health/health-data";
import { healthMessages } from "./health/health-messages";
import { type ReportMessages } from "./report-messages";
import { type ReportViewModel } from "./report-view-model";

export type ReportLoader<TInput> = {
  load: (env: AuthenticatedEnvironment, period: string) => Promise<TInput>;
  interpret: (input: TInput) => ReportViewModel;
  /**
   * The report's message catalog, carried BY VALUE on the registry entry. It
   * used to be registered as a side effect of importing the catalog module —
   * which the production SSR bundle tree-shook away (`"sideEffects": false`),
   * leaving `GET /api/v1/reports/health` throwing "no catalog registered".
   * A value on the entry cannot be dropped.
   */
  messages: ReportMessages;
};

function defineReport<TInput>(loader: ReportLoader<TInput>): ReportLoader<unknown> {
  return loader as ReportLoader<unknown>;
}

export const REPORT_REGISTRY: Record<string, ReportLoader<unknown>> = {
  health: defineReport({
    load: (env, period) => loadHealthInput(env, period),
    interpret: interpretHealth,
    messages: healthMessages,
  }),
};

export const REPORT_KEYS = Object.keys(REPORT_REGISTRY);

export function isReportKey(key: string): boolean {
  // Object.hasOwn, not `in`: `in` matches prototype keys ("toString", "__proto__"),
  // which would pass the route guard and then 500 in the loader.
  return Object.hasOwn(REPORT_REGISTRY, key);
}
