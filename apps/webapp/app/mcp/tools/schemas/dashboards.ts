import {
  DashboardWidgetDisplay,
  DashboardWidgetInput,
  DashboardWidgetPosition,
} from "@trigger.dev/core/v3/schemas";
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

const DashboardId = z
  .string()
  .regex(/^dashboard_[A-Za-z0-9]{1,64}$/, "a custom dashboard id starts with dashboard_")
  .describe("The custom dashboard id, starting with dashboard_. Use list_dashboards to find it.");

export const DashboardRefInput = ListDashboardsInput.extend({ dashboardId: DashboardId });

export const GetDashboardInput = DashboardRefInput.extend({
  widgetOffset: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(0)
    .describe("How many widgets to skip, to see the rest of a large dashboard"),
});

export const UpdateDashboardInput = DashboardRefInput.extend({
  title: z.string().trim().min(1).max(200).optional().describe("A new title for the dashboard"),
  description: z
    .string()
    .max(2000)
    .optional()
    .describe("A new description; an empty string clears it"),
});

const DISPLAY_CHARS = 8_000;

export const UpdateDashboardWidgetInput = DashboardRefInput.extend({
  widgetId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "a widget id has only letters, digits, _ and -")
    .describe("The widget id, as listed by get_dashboard"),
  title: z.string().trim().min(1).max(200).optional().describe("A new widget title"),
  query: z
    .string()
    .max(20_000)
    .optional()
    .describe("A new TRQL query; it replaces the widget's whole query"),
  display: DashboardWidgetDisplay.refine(
    (display) => JSON.stringify(display).length <= DISPLAY_CHARS,
    `display must be at most ${DISPLAY_CHARS} characters as JSON`
  )
    .optional()
    .describe("A new display: a table, a chart, a big number or a title section header"),
  fillGaps: z.boolean().optional().describe("Fill time buckets that have no data"),
  position: DashboardWidgetPosition.extend({
    y: z.number().int().min(0).max(10_000),
    h: z.number().int().min(1).max(1_000),
  })
    .optional()
    .describe("A new position on the 12-column grid: x 0-11, w 1-12, y 0-10000, h 1-1000"),
});
