import type { DashboardObject, ListDashboardsResponseBody } from "@trigger.dev/core/v3/schemas";
import { toolsMetadata } from "../config.js";
import { formatQueryResults } from "../formatters.js";
import {
  CreateDashboardInput,
  ListDashboardsInput,
  RunDashboardQueryInput,
  SetDashboardWidgetsInput,
} from "../schemas.js";
import { respondWithError, toolHandler } from "../utils.js";

// Cache dashboard listings keyed by project/environment.
const dashboardCache = new Map<string, { data: ListDashboardsResponseBody; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const listDashboardsTool = {
  name: toolsMetadata.list_dashboards.name,
  title: toolsMetadata.list_dashboards.title,
  description: toolsMetadata.list_dashboards.description,
  inputSchema: ListDashboardsInput.shape,
  handler: toolHandler(ListDashboardsInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling list_dashboards", { input });

    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment. Remove the --dev-only flag to access other environments.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["read:query"],
      branch: input.branch,
    });

    const cacheKey = `${apiClient.baseUrl}:${projectRef}:${input.environment}:${input.branch ?? ""}`;
    const cached = dashboardCache.get(cacheKey);
    let result: ListDashboardsResponseBody;
    if (cached && Date.now() < cached.expiresAt) {
      result = cached.data;
    } else {
      result = await apiClient.listDashboards();
      dashboardCache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    const content: string[] = ["## Available Dashboards", ""];

    for (const dashboard of result.dashboards) {
      const kind = dashboard.type === "custom" ? ", custom" : "";
      content.push(`### ${dashboard.title} (key: \`${dashboard.key}\`${kind})`);
      content.push("");
      content.push("| Widget ID | Title | Type |");
      content.push("|-----------|-------|------|");

      for (const widget of dashboard.widgets) {
        content.push(`| \`${widget.id}\` | ${widget.title} | ${widget.type} |`);
      }

      content.push("");
    }

    content.push(
      "Use the `run_dashboard_query` tool with a dashboard key and widget ID to execute a specific query."
    );

    return {
      content: [{ type: "text" as const, text: content.join("\n") }],
    };
  }),
};

export const runDashboardQueryTool = {
  name: toolsMetadata.run_dashboard_query.name,
  title: toolsMetadata.run_dashboard_query.title,
  description: toolsMetadata.run_dashboard_query.description,
  inputSchema: RunDashboardQueryInput.shape,
  handler: toolHandler(RunDashboardQueryInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling run_dashboard_query", { input });

    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment. Remove the --dev-only flag to access other environments.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["read:query"],
      branch: input.branch,
    });

    // Use cached dashboard listing if available, otherwise fetch
    const cacheKey = `${apiClient.baseUrl}:${projectRef}:${input.environment}:${input.branch ?? ""}`;
    const cached = dashboardCache.get(cacheKey);
    let dashboards: ListDashboardsResponseBody;
    if (cached && Date.now() < cached.expiresAt) {
      dashboards = cached.data;
    } else {
      dashboards = await apiClient.listDashboards();
      dashboardCache.set(cacheKey, { data: dashboards, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    const dashboard = dashboards.dashboards.find((d) => d.key === input.dashboardKey);

    if (!dashboard) {
      const available = dashboards.dashboards.map((d) => d.key).join(", ");
      return respondWithError(
        `Dashboard "${input.dashboardKey}" not found. Available dashboards: ${available}`
      );
    }

    const widget = dashboard.widgets.find((w) => w.id === input.widgetId);

    if (!widget) {
      const available = dashboard.widgets.map((w) => `${w.id} (${w.title})`).join(", ");
      return respondWithError(
        `Widget "${input.widgetId}" not found in dashboard "${input.dashboardKey}". Available widgets: ${available}`
      );
    }

    // Execute the widget's query
    const result = await apiClient.executeQuery(widget.query, {
      scope: input.scope,
      period: input.period ?? "1d",
      from: input.from,
      to: input.to,
      format: "json",
    });

    if (result.format === "json") {
      const rowCount = result.results.length;
      const formatted = formatQueryResults(result.results as Record<string, unknown>[]);

      const content = [
        `## ${widget.title}`,
        "",
        `**Dashboard:** ${dashboard.title} | **Widget:** \`${widget.id}\` | **${rowCount} row${rowCount === 1 ? "" : "s"}**`,
        "",
        formatted,
      ];

      return {
        content: [{ type: "text" as const, text: content.join("\n") }],
      };
    }

    return {
      content: [{ type: "text" as const, text: result.results }],
    };
  }),
};

function devOnlyError(environment: string) {
  return respondWithError(
    `This MCP server is only available for the dev environment. You tried to access the ${environment} environment. Remove the --dev-only flag to access other environments.`
  );
}

function describeDashboard(dashboard: DashboardObject, verb: string, url: string) {
  const lines = [
    `${verb} dashboard "${dashboard.title}" (id: \`${dashboard.id}\`, revision: \`${dashboard.revision}\`).`,
    "",
  ];

  if (dashboard.widgets.length > 0) {
    lines.push("| Widget ID | Title | Type |", "|-----------|-------|------|");
    for (const widget of dashboard.widgets) {
      lines.push(`| \`${widget.id}\` | ${widget.title} | ${widget.display.type} |`);
    }
    lines.push("");
  }

  lines.push(`[View in dashboard](${url})`);
  return lines.join("\n");
}

export const createDashboardTool = {
  name: toolsMetadata.create_dashboard.name,
  title: toolsMetadata.create_dashboard.title,
  description: toolsMetadata.create_dashboard.description,
  inputSchema: CreateDashboardInput.shape,
  handler: toolHandler(CreateDashboardInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling create_dashboard", { input });

    if (ctx.options.devOnly && input.environment !== "dev") {
      return devOnlyError(input.environment);
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["read:query", "write:query"],
      branch: input.branch,
    });

    const dashboard = await apiClient.createDashboard({
      title: input.title,
      description: input.description,
      widgets: input.widgets,
    });
    dashboardCache.clear();

    const url = await ctx.getDashboardUrl(
      `/projects/v3/${projectRef}/dashboards/${dashboard.id}?env=${input.environment}`
    );

    return {
      content: [{ type: "text" as const, text: describeDashboard(dashboard, "Created", url) }],
    };
  }),
};

export const setDashboardWidgetsTool = {
  name: toolsMetadata.set_dashboard_widgets.name,
  title: toolsMetadata.set_dashboard_widgets.title,
  description: toolsMetadata.set_dashboard_widgets.description,
  inputSchema: SetDashboardWidgetsInput.shape,
  handler: toolHandler(SetDashboardWidgetsInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling set_dashboard_widgets", { input });

    if (ctx.options.devOnly && input.environment !== "dev") {
      return devOnlyError(input.environment);
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["read:query", "write:query"],
      branch: input.branch,
    });

    const dashboard = await apiClient.replaceDashboard(input.dashboardId, {
      title: input.title,
      widgets: input.widgets,
    });
    dashboardCache.clear();

    const url = await ctx.getDashboardUrl(
      `/projects/v3/${projectRef}/dashboards/${dashboard.id}?env=${input.environment}`
    );

    return {
      content: [{ type: "text" as const, text: describeDashboard(dashboard, "Updated", url) }],
    };
  }),
};
