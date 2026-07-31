import { json } from "@remix-run/server-runtime";
import { ReportFormatSchema, ReportPeriodSchema } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import { ReportPresenter } from "~/presenters/v3/reports/ReportPresenter.server";
import {
  isReportKey,
  REPORT_KEYS,
  reportQueryTables,
} from "~/presenters/v3/reports/report-registry";
import { renderReportAnsi, renderReportMarkdown } from "~/presenters/v3/reports/renderMarkdown";
import { type ReportViewModel } from "~/presenters/v3/reports/report-view-model";
import { logger } from "~/services/logger.server";
import { createLoaderApiRoute, everyResource } from "~/services/routeBuilders/apiBuilder.server";

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

export const loader = createLoaderApiRoute(
  {
    params: ReportParamsSchema,
    searchParams: ReportSearchParamsSchema,
    // The MCP `get_report` tool calls this with a scoped JWT (read:query), so JWT auth
    // must be allowed — same as api.v1.query.ts.
    allowJWT: true,
    findResource: async () => 1, // dummy — report key validated in the handler
    authorization: {
      action: "read",
      resource: (_, params) => reportAuthResource(params.key),
    },
  },
  async ({ params, searchParams, authentication }) => {
    if (!isReportKey(params.key)) {
      return json(
        { error: `Unknown report "${params.key}". Available: ${REPORT_KEYS.join(", ")}.` },
        { status: 404 }
      );
    }

    try {
      const presenter = new ReportPresenter();
      const vm = await presenter.call({
        environment: authentication.environment,
        key: params.key,
        period: searchParams.period,
      });

      if (!vm) {
        return json({ error: `Unknown report "${params.key}".` }, { status: 404 });
      }

      return reportResponse(vm, searchParams.format);
    } catch (error) {
      logger.error("Failed to render report", { error, key: params.key });
      return json({ error: "Something went wrong, please try again." }, { status: 500 });
    }
  }
);
