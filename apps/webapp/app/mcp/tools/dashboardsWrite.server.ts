import type { DashboardObject } from "@trigger.dev/core/v3/schemas";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import {
  assertValidWidgetQueries,
  MetricDashboardService,
  toDashboardObject,
} from "~/v3/services/metricDashboard.server";
import { fenceUntrusted } from "../gate/fence.server";
import type { McpToolResult } from "../gate/withMcpToolAuth.server";
import type { McpToolDefinition } from "../registry.server";
import { dashboardUrl, errorResult, textResult } from "./define.server";
import { defineWriteTool } from "./defineWrite.server";
import { subjectEnvironment } from "./query.server";
import { CreateDashboardInput, SetDashboardWidgetsInput } from "./schemas/dashboards";

const fence = (text: string) => fenceUntrusted(text, "dashboard");

function describeDashboard(dashboard: DashboardObject, verb: string, url: string) {
  const lines = [
    `${verb} dashboard "${fence(dashboard.title)}" (id: \`${dashboard.id}\`, revision: \`${dashboard.revision}\`).`,
    "",
  ];

  if (dashboard.widgets.length > 0) {
    lines.push("| Widget ID | Title | Type |", "|-----------|-------|------|");
    for (const widget of dashboard.widgets) {
      lines.push(`| \`${widget.id}\` | ${fence(widget.title)} | ${widget.display.type} |`);
    }
    lines.push("");
  }

  lines.push(`[View in dashboard](${url})`);
  return lines.join("\n");
}

async function guarded(fn: () => Promise<McpToolResult>): Promise<McpToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ServiceValidationError) return errorResult(e.message);
    throw e;
  }
}

export const dashboardsWriteTools: McpToolDefinition[] = [
  defineWriteTool({
    name: "create_dashboard",
    title: "Create Dashboard",
    description:
      "Create a custom metrics dashboard, optionally with widgets. Each widget has a title, a TRQL query (use get_query_schema to see the tables and columns, and the query tool to try a query first), and a display: a table, a chart (bar or line, with x-axis and y-axis columns), a big number, or a title section header. Widgets without a position are stacked full width in order. Returns the dashboard id.",
    shape: CreateDashboardInput.shape,
    approval: "configurable",
    auth: { action: "write", subject: "query" },
    run: async (input, ctx) => {
      const environment = await subjectEnvironment(ctx);
      if (!environment) return errorResult("Environment not found");

      return guarded(async () => {
        if (input.widgets) assertValidWidgetQueries(input.widgets);

        const row = await new MetricDashboardService().create({
          organizationId: environment.organizationId,
          projectId: environment.projectId,
          ownerId: ctx.identity.userId,
          title: input.title,
          description: input.description,
          widgets: input.widgets,
        });
        const dashboard = toDashboardObject(row);

        const url = dashboardUrl(
          `/projects/v3/${environment.project.externalRef}/dashboards/${dashboard.id}?env=${input.environment}`
        );
        return textResult(describeDashboard(dashboard, "Created", url));
      });
    },
  }),
  defineWriteTool({
    name: "set_dashboard_widgets",
    title: "Set Dashboard Widgets",
    description:
      "Replace every widget on a custom dashboard with the given list, and optionally rename it. A widget that already exists keeps its position unless you pass a new one; new widgets without a position are stacked full width below the others. Use list_dashboards to find the dashboard id.",
    shape: SetDashboardWidgetsInput.shape,
    approval: "configurable",
    auth: { action: "write", subject: "query" },
    run: async (input, ctx) => {
      const environment = await subjectEnvironment(ctx);
      if (!environment) return errorResult("Environment not found");

      return guarded(async () => {
        assertValidWidgetQueries(input.widgets);

        const row = await new MetricDashboardService().replace({
          organizationId: environment.organizationId,
          friendlyId: input.dashboardId,
          title: input.title,
          widgets: input.widgets,
        });
        const dashboard = toDashboardObject(row);

        const url = dashboardUrl(
          `/projects/v3/${environment.project.externalRef}/dashboards/${dashboard.id}?env=${input.environment}`
        );
        return textResult(describeDashboard(dashboard, "Updated", url));
      });
    },
  }),
];
