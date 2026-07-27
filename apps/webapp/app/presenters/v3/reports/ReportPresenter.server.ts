/**
 * Thin orchestrator: load -> interpret -> return the generic ReportViewModel. No SQL or render
 * here — data access lives in each report's `load`, meaning in `interpret`, presentation in the
 * renderers, and the catalog of reports in `report-registry.ts`.
 *
 * `call` takes a resolved AuthenticatedEnvironment and is transport-independent (Seam B, §7):
 * any future surface (MCP Resource, etc.) is just another caller of this same method.
 */

import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { REPORT_REGISTRY } from "./report-registry";
import { type ReportViewModel } from "./report-view-model";

const DEFAULT_PERIOD = "1h";

/**
 * Single-flight: collapse concurrent identical requests (same report/env/period) into one
 * computation. A report fires up to ~9 ClickHouse queries and MCP/CLI clients easily call it
 * several times at once — without this, N callers each launch the full query set and pile onto
 * the per-project query-concurrency limit. Keyed per (key, env, period); entry drops on settle.
 */
const inFlight = new Map<string, Promise<ReportViewModel | undefined>>();

export class ReportPresenter {
  async call({
    environment,
    key,
    period = DEFAULT_PERIOD,
  }: {
    environment: AuthenticatedEnvironment;
    key: string;
    period?: string;
  }): Promise<ReportViewModel | undefined> {
    const loader = REPORT_REGISTRY[key];
    if (!loader) return undefined;

    const flightKey = `${key} ${environment.id} ${period}`;
    const existing = inFlight.get(flightKey);
    if (existing) return existing;

    const promise = (async () => {
      const input = await loader.load(environment, period);
      return loader.interpret(input);
    })().finally(() => inFlight.delete(flightKey));

    inFlight.set(flightKey, promise);
    return promise;
  }
}
