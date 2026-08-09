// Outside the route module because a Remix route may only export loader, action and headers.
import { json } from "@remix-run/server-runtime";
import { ReportFormatSchema, ReportPeriodSchema } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import { renderReportAnsi, renderReportMarkdown } from "~/presenters/v3/reports/renderMarkdown";
import { type ReportViewModel } from "~/presenters/v3/reports/report-view-model";

export const ReportParamsSchema = z.object({
  key: z.string(),
});

// `period` and `format` come from core, the same definitions the API clients and CLI use.
export const ReportSearchParamsSchema = z.object({
  period: ReportPeriodSchema.optional(),
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
