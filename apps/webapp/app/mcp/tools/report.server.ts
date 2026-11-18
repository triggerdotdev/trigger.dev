import { ReportPresenter } from "~/presenters/v3/reports/ReportPresenter.server";
import { isReportKey, REPORT_KEYS } from "~/presenters/v3/reports/report-registry";
import type { ReportViewModel } from "~/presenters/v3/reports/report-view-model";
import { renderReportAnsi, renderReportMarkdown } from "~/presenters/v3/reports/renderMarkdown";
import { fenceUntrusted } from "../gate/fence.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult, resolveToolEnvironment, textResult } from "./define.server";
import { GetReportInput } from "./schemas/report";

function fenceReportViewModel(vm: ReportViewModel): ReportViewModel {
  return {
    ...vm,
    scope: fenceUntrusted(vm.scope, "report-scope"),
    findings: vm.findings.map((finding) =>
      finding.attribution
        ? {
            ...finding,
            attribution: {
              ...finding.attribution,
              key: fenceUntrusted(finding.attribution.key, "report-attribution"),
            },
          }
        : finding
    ),
  };
}

export function renderReport(vm: ReportViewModel, color: boolean | undefined): string {
  const fenced = fenceReportViewModel(vm);
  return color ? renderReportAnsi(fenced) : renderReportMarkdown(fenced);
}

export const reportTools: McpToolDefinition[] = [
  defineReadTool({
    name: "get_report",
    title: "Get Report",
    description:
      "Render an interpreted report (an answered question, not a raw panel) as text + sparklines. The server computes the verdict deterministically. Currently: 'health' — whether work is flowing, whether the runs that start are healthy, and whether the telemetry is fresh, with a headline verdict and a suggested next action.",
    shape: GetReportInput.shape,
    auth: { action: "read", subject: "query" },
    run: async (input, ctx) => {
      if (!isReportKey(input.key)) {
        return errorResult(`Unknown report "${input.key}". Available: ${REPORT_KEYS.join(", ")}.`);
      }

      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return errorResult("Not authorized");

      const vm = await new ReportPresenter().call({
        environment,
        key: input.key,
        period: input.period,
      });
      if (!vm) return errorResult(`Unknown report "${input.key}".`);

      return textResult(renderReport(vm, input.color));
    },
  }),
];
