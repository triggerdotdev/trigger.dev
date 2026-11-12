import { DashboardWidgetInput } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import { CommonProjectsInput } from "./common";

export const ListDashboardsInput = CommonProjectsInput.pick({
  projectRef: true,
  configPath: true,
  environment: true,
  branch: true,
});

export const CreateDashboardInput = ListDashboardsInput.extend({
  title: z.string().describe("The dashboard title"),
  description: z.string().optional().describe("An optional description"),
  widgets: z
    .array(DashboardWidgetInput)
    .optional()
    .describe("The widgets to add, in order. Leave out to create an empty dashboard."),
});

export const SetDashboardWidgetsInput = ListDashboardsInput.extend({
  dashboardId: z.string().describe("The custom dashboard id, as listed by list_dashboards"),
  title: z.string().optional().describe("A new title for the dashboard"),
  widgets: z
    .array(DashboardWidgetInput)
    .describe("The full list of widgets the dashboard should have"),
});

export const RunDashboardQueryInput = CommonProjectsInput.extend({
  dashboardKey: z
    .string()
    .describe(
      "The dashboard key (e.g. 'overview', 'llm'). Use list_dashboards to discover available dashboards."
    ),
  widgetId: z
    .string()
    .describe(
      "The widget ID to execute. Use list_dashboards to see available widget IDs and their queries."
    ),
  period: z
    .string()
    .optional()
    .describe("Time period shorthand, e.g. '1h', '7d', '30d'. Defaults to 1d."),
  from: z.string().optional().describe("Start of time range (ISO 8601). Must be paired with 'to'."),
  to: z.string().optional().describe("End of time range (ISO 8601). Must be paired with 'from'."),
  scope: z
    .enum(["environment", "project", "organization"])
    .default("environment")
    .describe("Data access scope."),
});
