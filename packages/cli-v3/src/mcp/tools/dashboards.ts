import type { ListDashboardsResponseBody } from "@trigger.dev/core/v3/schemas";
import { toolsMetadata } from "../config.js";
import { formatQueryResults } from "../formatters.js";
import { ListDashboardsInput, RunDashboardQueryInput } from "../schemas.js";
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

    const cacheKey = `${projectRef}:${input.environment}:${input.branch ?? ""}`;
    const result = await apiClient.listDashboards();
    dashboardCache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });

    const content: string[] = ["## Available Dashboards", ""];

    for (const dashboard of result.dashboards) {
      content.push(`### ${dashboard.title} (key: \`${dashboard.key}\`)`);
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
    const cacheKey = `${projectRef}:${input.environment}:${input.branch ?? ""}`;
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
