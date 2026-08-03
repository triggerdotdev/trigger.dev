/**
 * The reports API route's schemas and helpers, out of the route module: a Remix
 * route may only export `loader`/`action`/`headers` alongside client-safe code,
 * and these depend on server-only modules (the vite build rejects the route
 * otherwise). The route and the tests both import from here.
 */
import { json } from "@remix-run/server-runtime";
import { ReportFormatSchema, ReportPeriodSchema } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import { reportQueryTables } from "~/presenters/v3/reports/report-registry";
import { renderReportAnsi, renderReportMarkdown } from "~/presenters/v3/reports/renderMarkdown";
import { type ReportViewModel } from "~/presenters/v3/reports/report-view-model";
import { everyResource } from "~/services/routeBuilders/apiBuilder.server";

export const ReportParamsSchema = z.object({
  key: z.string(),
});

/**
 * `period` and `format` come from `@trigger.dev/core/v3/schemas` — the same definitions the API
 * clients and the CLI use, so the accepted grammar can't drift between them. Note `period`
 * rejects seconds: reports bucket by whole minutes.
 */
export const ReportSearchParamsSchema = z.object({
  period: ReportPeriodSchema.optional(),
  // markdown (default) for CLI/MCP · json (the raw VM) for web · ansi for a colour terminal.
  format: ReportFormatSchema.default("markdown"),
});

export type ReportFormatParam = z.infer<typeof ReportFormatSchema>;

/** Render the view model in the requested encoding, with the matching content type. */
export function reportResponse(vm: ReportViewModel, format: ReportFormatParam): Response {
  switch (format) {
    case "json":
      return json(vm, { status: 200 });
    case "ansi":
      return new Response(renderReportAnsi(vm), {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    case "markdown":
      return new Response(renderReportMarkdown(vm), {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
  }
}

/**
 * Authorize per-table (like api.v1.query.ts) rather than the permissive
 * `{ type: "query", id: "all" }`: a JWT must be scoped to every table the *selected* report
 * reads, so a token scoped to only some tables can't fetch a report that reads others. The
 * tables come from the registry entry, so a narrower report gets a narrower check for free.
 */
export function reportAuthResource(key: string) {
  return everyResource(reportQueryTables(key).map((id) => ({ type: "query", id })));
}
