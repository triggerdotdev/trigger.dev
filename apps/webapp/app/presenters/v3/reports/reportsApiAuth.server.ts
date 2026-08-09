// Apart from `reportsApi.server.ts` so that rendering a report doesn't drag the route
// builder — and `env.server` behind it — into everything that serializes one.
import { isReportKey, reportQueryTables } from "~/presenters/v3/reports/report-registry";
import { everyResource } from "~/services/routeBuilders/apiBuilder.server";

/**
 * Per-table, not the permissive `{ type: "query", id: "all" }`: a JWT must be scoped to every table
 * the report reads, so a partially scoped token can't reach the others.
 */
export function reportAuthResource(key: string) {
  // A key that names no report declares no tables, so there is nothing to authorize against.
  if (!isReportKey(key)) return everyResource([]);
  return everyResource(reportQueryTables(key).map((id) => ({ type: "query", id })));
}
