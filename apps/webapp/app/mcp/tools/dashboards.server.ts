import type { DashboardSummary, DashboardWidgetSummary } from "@trigger.dev/core/v3/schemas";
import { builtInDashboard } from "~/presenters/v3/BuiltInDashboards.server";
import type { BuiltInDashboard } from "~/presenters/v3/MetricDashboardPresenter.server";
import { MetricDashboardService, toDashboardSummary } from "~/v3/services/metricDashboard.server";
import { fenceUntrusted } from "../gate/fence.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult, textResult } from "./define.server";
import { queryResultText, runScopedQuery, subjectEnvironment } from "./query.server";
import { ListDashboardsInput, RunDashboardQueryInput } from "./schemas/dashboards";

const BUILT_IN_DASHBOARD_KEYS = ["overview", "llm"];

const fence = (text: string) => fenceUntrusted(text, "dashboard");

function serializeBuiltIn(dashboard: BuiltInDashboard): DashboardSummary {
  const widgets: DashboardWidgetSummary[] = [];

  if (dashboard.layout.version === "1") {
    for (const [id, widget] of Object.entries(dashboard.layout.widgets)) {
      if (widget.display.type === "title") continue;
      widgets.push({ id, title: widget.title, query: widget.query, type: widget.display.type });
    }
  }

  return { key: dashboard.key, title: dashboard.title, type: "builtIn", widgets };
}

async function listDashboards(organizationId: string): Promise<DashboardSummary[]> {
  const builtIn = BUILT_IN_DASHBOARD_KEYS.map((key) => {
    try {
      return serializeBuiltIn(builtInDashboard(key));
    } catch {
      return null;
    }
  }).filter((d): d is DashboardSummary => d !== null);

  const custom = await new MetricDashboardService().list(organizationId);
  return [...builtIn, ...custom.map(toDashboardSummary)];
}

export const dashboardsTools: McpToolDefinition[] = [
  defineReadTool({
    name: "list_dashboards",
    title: "List Dashboards",
    description:
      "List the built-in dashboards and the organization's custom dashboards, with their widgets. Built-in dashboards contain pre-built queries for common metrics like run success rates, costs, LLM usage, and more. Use run_dashboard_query to execute a widget's query.",
    shape: ListDashboardsInput.shape,
    auth: { action: "read", subject: "query" },
    run: async (_input, { subject }) => {
      const dashboards = await listDashboards(subject!.organizationId);

      const content: string[] = ["## Available Dashboards", ""];

      for (const dashboard of dashboards) {
        const kind = dashboard.type === "custom" ? ", custom" : "";
        content.push(`### ${fence(dashboard.title)} (key: \`${dashboard.key}\`${kind})`);
        content.push("");
        content.push("| Widget ID | Title | Type |");
        content.push("|-----------|-------|------|");

        for (const widget of dashboard.widgets) {
          content.push(`| \`${widget.id}\` | ${fence(widget.title)} | ${widget.type} |`);
        }

        content.push("");
      }

      content.push(
        "Use the `run_dashboard_query` tool with a dashboard key and widget ID to execute a specific query."
      );

      return textResult(content.join("\n"));
    },
  }),
  defineReadTool({
    name: "run_dashboard_query",
    title: "Run Dashboard Query",
    description:
      "Execute a single widget query from a built-in or custom dashboard. Use list_dashboards first to see available dashboards, widget IDs, and their queries. Supports time period and scope options.",
    shape: RunDashboardQueryInput.shape,
    auth: { action: "read", subject: "query" },
    run: async (input, ctx) => {
      const environment = await subjectEnvironment(ctx);
      if (!environment) return errorResult("Environment not found");

      const dashboards = await listDashboards(ctx.subject!.organizationId);
      const dashboard = dashboards.find((d) => d.key === input.dashboardKey);

      if (!dashboard) {
        const available = dashboards.map((d) => d.key).join(", ");
        return errorResult(
          `Dashboard "${input.dashboardKey}" not found. Available dashboards: ${available}`
        );
      }

      const widget = dashboard.widgets.find((w) => w.id === input.widgetId);

      if (!widget) {
        const available = dashboard.widgets.map((w) => `${w.id} (${fence(w.title)})`).join(", ");
        return errorResult(
          `Widget "${input.widgetId}" not found in dashboard "${input.dashboardKey}". Available widgets: ${available}`
        );
      }

      const result = await runScopedQuery(environment, {
        query: widget.query,
        scope: input.scope,
        period: input.period ?? "1d",
        from: input.from,
        to: input.to,
      });
      if (!result.ok) return errorResult(result.error);

      const rowCount = result.rows.length;
      return queryResultText(
        result.rows,
        [
          `## ${fence(widget.title)}`,
          "",
          `**Dashboard:** ${fence(dashboard.title)} | **Widget:** \`${widget.id}\` | **${rowCount} row${rowCount === 1 ? "" : "s"}**`,
          "",
        ],
        "dashboard"
      );
    },
  }),
];
