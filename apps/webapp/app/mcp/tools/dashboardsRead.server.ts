import type { DashboardObject } from "@trigger.dev/core/v3/schemas";
import {
  QUERY_HISTORY_LIMIT,
  QueryPresenter,
  type QueryHistoryItem,
} from "~/presenters/v3/QueryPresenter.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { MetricDashboardService, toDashboardObject } from "~/v3/services/metricDashboard.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, textResult } from "./define.server";
import {
  dashboardNotFound,
  fenced,
  fencedJson,
  isoTime,
  plainError,
  plainOr,
  plural,
  WIDGET_ID,
} from "./format/insights";
import { subjectEnvironment } from "./query.server";
import { GetDashboardInput, ListDashboardsInput } from "./schemas/dashboards";

const QUERY_CHARS = 20_000;
const DESCRIPTION_CHARS = 2_000;
const DISPLAY_CHARS = 8_000;
const MAX_WIDGETS = 40;
const SCOPES = new Set(["environment", "project", "organization"]);
const PERIOD = /^\d{1,6}[smhdwy]$/;

export async function findDashboard(organizationId: string, dashboardId: string) {
  try {
    return await new MetricDashboardService().get({ organizationId, friendlyId: dashboardId });
  } catch (error) {
    if (error instanceof ServiceValidationError) return null;
    throw error;
  }
}

function formatDashboard(dashboard: DashboardObject, offset: number, maxWidgets: number): string {
  const lines = [
    `## ${fenced(dashboard.title, "dashboard-title")} (id: \`${dashboard.id}\`)`,
    "",
    dashboard.description
      ? `Description: ${fenced(dashboard.description, "dashboard-description", DESCRIPTION_CHARS)}`
      : "No description.",
    `Revision: ${dashboard.revision}`,
    `${plural(dashboard.widgets.length, "widget")}, in grid order (top to bottom, left to right).`,
  ];

  const shown = dashboard.widgets.slice(offset, offset + maxWidgets);
  if (offset > 0 || shown.length < dashboard.widgets.length) {
    lines.push(
      shown.length === 0
        ? `No widgets from position ${offset + 1}.`
        : `Showing widgets ${offset + 1}-${offset + shown.length}.`
    );
  }

  for (const widget of shown) {
    const { x, y, w, h } = widget.position;
    lines.push(
      "",
      `### Widget ${plainOr(widget.id, WIDGET_ID, "widget-id")}: ${fenced(widget.title, "widget-title")}`,
      `Type: ${widget.display.type}; position x=${x} y=${y} w=${w} h=${h}${
        widget.fillGaps === undefined ? "" : `; fill gaps: ${widget.fillGaps ? "on" : "off"}`
      }`
    );
    if (widget.display.type !== "title") {
      lines.push(
        `Display: ${fencedJson(widget.display, "widget-display", DISPLAY_CHARS)}`,
        `Query: ${fenced(widget.query, "widget-query", QUERY_CHARS)}`
      );
    }
  }

  const next = offset + shown.length;
  if (next < dashboard.widgets.length) {
    lines.push(
      "",
      `${plural(dashboard.widgets.length - next, "more widget")} not shown: call again with widgetOffset ${next}.`
    );
  }
  return lines.join("\n");
}

function formatHistoryItem(item: QueryHistoryItem, index: number): string[] {
  const title = item.title ? fenced(item.title, "query-title") : "Untitled";
  const by = item.userName ? ` by ${fenced(item.userName, "query-user")}` : "";
  const scope = SCOPES.has(item.scope) ? item.scope : fenced(item.scope, "query-scope");
  const range =
    item.filterFrom || item.filterTo
      ? `from ${item.filterFrom ? isoTime(item.filterFrom) : "the start"} to ${item.filterTo ? isoTime(item.filterTo) : "now"}`
      : item.filterPeriod
        ? `last ${plainOr(item.filterPeriod, PERIOD, "query-period")}`
        : "default range";
  return [
    `${index + 1}. ${title}: run ${isoTime(item.createdAt)}${by}; scope: ${scope}; time range: ${range}`,
    `   Query: ${fenced(item.query, "query-text", QUERY_CHARS)}`,
  ];
}

export const dashboardsReadTools: McpToolDefinition[] = [
  defineReadTool({
    name: "get_dashboard",
    title: "Get Dashboard",
    description:
      "Get one custom dashboard in full: its title, description, revision and every widget with its title, display settings, grid position and TRQL query. Use list_dashboards to find the dashboard id.",
    shape: GetDashboardInput.shape,
    auth: { action: "read", subject: "query" },
    run: async (input, ctx) => {
      const environment = await subjectEnvironment(ctx);
      if (!environment) return plainError("Environment not found");

      const dashboard = await findDashboard(environment.organizationId, input.dashboardId);
      if (!dashboard) return plainError(`${dashboardNotFound(input.dashboardId)}.`);

      return textResult(
        formatDashboard(toDashboardObject(dashboard), input.widgetOffset, MAX_WIDGETS)
      );
    },
  }),
  defineReadTool({
    name: "list_query_history",
    title: "List Query History",
    description:
      "List the 20 most recent queries run in the organization, newest first, as the Query page's history shows them: title, who ran it and when, scope, time range and the TRQL text. Use the query tool to run one again.",
    shape: ListDashboardsInput.shape,
    auth: { action: "read", subject: "query" },
    run: async (_input, ctx) => {
      const environment = await subjectEnvironment(ctx);
      if (!environment) return plainError("Environment not found");

      const { history } = await new QueryPresenter().call({
        organizationId: environment.organizationId,
      });
      if (history.length === 0) return textResult("No queries have been run yet.");

      const header =
        history.length >= QUERY_HISTORY_LIMIT
          ? `## Showing the ${QUERY_HISTORY_LIMIT} most recent queries, newest first, from everyone in the organization; older queries are not listed.`
          : `## Query history (${history.length} ${history.length === 1 ? "query" : "queries"}, newest first, from everyone in the organization)`;
      return textResult([header, "", ...history.flatMap(formatHistoryItem)].join("\n"));
    },
  }),
];
