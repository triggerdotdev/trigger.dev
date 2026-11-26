import type {
  DashboardWidget,
  DashboardWidgetDisplay,
  DashboardWidgetPosition,
} from "@trigger.dev/core/v3/schemas";
import type { z } from "zod";
import { getUserById } from "~/models/user.server";
import { removeFavoritesByUrlSubstring } from "~/services/dashboardPreferences.server";
import { logger } from "~/services/logger.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import {
  assertValidWidgetQueries,
  getDashboardLimits,
  MetricDashboardService,
  toDashboardObject,
} from "~/v3/services/metricDashboard.server";
import { canonicalJson } from "../confirm/confirmation.server";
import type { McpPreviewRefusal, McpSubject } from "../gate/types";
import type { McpToolContext, McpToolResult } from "../gate/withMcpToolAuth.server";
import type { McpToolDefinition } from "../registry.server";
import { findDashboard } from "./dashboardsRead.server";
import { dashboardUrl, textResult } from "./define.server";
import { defineWriteTool, staleAnswer, staleApproval } from "./defineWrite.server";
import { dashboardNotFound, fenced, plainError, plural } from "./format/insights";
import { untrusted } from "./format/logFields";
import { escapeText, quote } from "./format/runsEditPreview";
import { subjectEnvironment } from "./query.server";
import {
  DashboardRefInput,
  UpdateDashboardInput,
  UpdateDashboardWidgetInput,
} from "./schemas/dashboards";

const auth = { action: "write", subject: "query" } as const;

type WidgetArgs = z.output<typeof UpdateDashboardWidgetInput>;
type UpdateArgs = z.output<typeof UpdateDashboardInput>;
type DeleteArgs = z.output<typeof DashboardRefInput>;

const notFound = (dashboardId: string) => ({
  refuse: `${dashboardNotFound(dashboardId)}; nothing changed.`,
});
const ERROR_CHARS = 2_000;
const FAVORITES_LINE =
  "Your own side-menu favourites that link to it are removed; other members' favourites stay.";
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const revisionLine = (revision: string) =>
  `Dashboard revision ${revision}: if the dashboard changes before this runs, it is refused.`;

type Plan = { preview: string; revision: string };
const previewOf = (plan: Plan | McpPreviewRefusal) => ("refuse" in plan ? plan : plan.preview);

async function loadDashboard(subject: McpSubject | null, dashboardId: string) {
  if (!subject) return null;
  const row = await findDashboard(subject.organizationId, dashboardId);
  return row ? toDashboardObject(row) : null;
}

type WidgetChanges = {
  title?: string;
  query?: string;
  display?: DashboardWidgetDisplay;
  fillGaps?: boolean;
  position?: DashboardWidgetPosition;
};

const widgetChanges = (args: WidgetArgs, widget: DashboardWidget): WidgetChanges => ({
  ...(args.title !== undefined && args.title !== widget.title ? { title: args.title } : {}),
  ...(args.query !== undefined && args.query !== widget.query ? { query: args.query } : {}),
  ...(args.display !== undefined && !same(args.display, widget.display)
    ? { display: args.display }
    : {}),
  ...(args.fillGaps !== undefined && args.fillGaps !== (widget.fillGaps ?? false)
    ? { fillGaps: args.fillGaps }
    : {}),
  ...(args.position !== undefined && !same(args.position, widget.position)
    ? { position: args.position }
    : {}),
});

const nothingChanged = (text: string) => ({ refuse: `${text}; nothing changed.` });

async function widgetPlan(
  args: WidgetArgs,
  subject: McpSubject | null
): Promise<(Plan & { changes: WidgetChanges }) | McpPreviewRefusal> {
  const given = ["title", "query", "display", "fillGaps", "position"] as const;
  if (given.every((key) => args[key] === undefined)) return nothingChanged("No changes given");

  const dashboard = await loadDashboard(subject, args.dashboardId);
  if (!dashboard) return notFound(args.dashboardId);
  const widget = dashboard.widgets.find((w) => w.id === args.widgetId);
  if (!widget)
    return nothingChanged(`Widget ${escapeText(args.widgetId)} not found on this dashboard`);

  const changes = widgetChanges(args, widget);
  if (Object.keys(changes).length === 0) {
    return nothingChanged(`Widget ${escapeText(widget.id)} already has these values`);
  }

  const next = {
    id: widget.id,
    title: changes.title ?? widget.title,
    query: changes.query ?? widget.query,
    display: changes.display ?? widget.display,
  };
  if (next.display.type !== "title" && !next.query) {
    return nothingChanged("Query is required for chart widgets");
  }
  if (changes.query !== undefined || changes.display !== undefined) {
    try {
      assertValidWidgetQueries([next]);
    } catch (error) {
      if (error instanceof ServiceValidationError) {
        return nothingChanged(untrusted(error.message, "query-error", ERROR_CHARS));
      }
      throw error;
    }
  }
  if (widget.display.type === "title" && next.display.type !== "title" && subject) {
    const { widgetsPerDashboard } = await getDashboardLimits(subject.organizationId);
    const counted = dashboard.widgets.filter((w) => w.display.type !== "title").length;
    if (counted + 1 > widgetsPerDashboard) {
      return nothingChanged(
        `Widget limit reached: the plan allows ${widgetsPerDashboard} widgets on a dashboard and this one has ${counted}`
      );
    }
  }

  const lines = [
    `Update widget ${escapeText(widget.id)} (titled ${quote(widget.title)}) on dashboard ${quote(dashboard.title)} (${dashboard.id}):`,
  ];
  if (changes.title !== undefined) lines.push(`- Title: ${escapeText(changes.title)}`);
  if (changes.query !== undefined) {
    lines.push(`- Query, replacing the current query in full: ${escapeText(changes.query)}`);
  }
  if (changes.display !== undefined) {
    lines.push(`- Display: ${escapeText(canonicalJson(changes.display))}`);
    if (widget.display.type === "title" && changes.display.type !== "title") {
      lines.push(
        "  This turns a section header into a widget that counts towards the plan's limit."
      );
    }
  }
  if (changes.fillGaps !== undefined) lines.push(`- Fill gaps: ${changes.fillGaps ? "on" : "off"}`);
  if (changes.position !== undefined) {
    const { x, y, w, h } = changes.position;
    lines.push(`- Position: x=${x} y=${y} w=${w} h=${h}; other widgets keep their positions`);
  }
  lines.push("Everything else on the widget and the dashboard stays as it is.");
  lines.push(revisionLine(dashboard.revision));
  return { preview: lines.join("\n"), changes, revision: dashboard.revision };
}

async function updatePlan(
  args: UpdateArgs,
  subject: McpSubject | null
): Promise<Plan | McpPreviewRefusal> {
  if (args.title === undefined && args.description === undefined) {
    return nothingChanged("No changes given");
  }
  const dashboard = await loadDashboard(subject, args.dashboardId);
  if (!dashboard) return notFound(args.dashboardId);

  const rename = args.title !== undefined && args.title !== dashboard.title;
  const describe = args.description !== undefined && args.description !== dashboard.description;
  if (!rename && !describe) {
    return nothingChanged(`Dashboard ${dashboard.id} already has this title and description`);
  }

  const lines = [`Update dashboard ${quote(dashboard.title)} (${dashboard.id}):`];
  if (rename) lines.push(`- Rename it to ${escapeText(args.title!)}`);
  if (describe) {
    lines.push(
      args.description
        ? `- Replace its description with ${escapeText(args.description)}`
        : "- Clear its description"
    );
  }
  lines.push("Its widgets are not changed.");
  lines.push(revisionLine(dashboard.revision));
  return { preview: lines.join("\n"), revision: dashboard.revision };
}

async function deletePlan(
  args: DeleteArgs,
  subject: McpSubject | null
): Promise<Plan | McpPreviewRefusal> {
  const dashboard = await loadDashboard(subject, args.dashboardId);
  if (!dashboard) return notFound(args.dashboardId);
  const preview = [
    `Delete dashboard ${quote(dashboard.title)} (${dashboard.id}) and its ${plural(dashboard.widgets.length, "widget")} for everyone in the organization.`,
    "This cannot be undone.",
    FAVORITES_LINE,
    revisionLine(dashboard.revision),
  ].join(" ");
  return { preview, revision: dashboard.revision };
}

async function written(
  ctx: McpToolContext,
  plan: Plan | McpPreviewRefusal,
  write: (revision: string) => Promise<McpToolResult>
): Promise<McpToolResult> {
  if ("refuse" in plan) return plainError(plan.refuse);
  const stale = staleApproval(ctx, plan.preview, plainError);
  if (stale) return stale;
  try {
    return await write(plan.revision);
  } catch (error) {
    if (error instanceof ServiceValidationError && error.status === 409 && ctx.confirmation) {
      return staleAnswer(plainError);
    }
    if (error instanceof ServiceValidationError) {
      return plainError(untrusted(error.message, "dashboard-error", ERROR_CHARS));
    }
    throw error;
  }
}

const viewUrl = (projectRef: string, dashboardId: string, environment: string) =>
  dashboardUrl(`/projects/v3/${projectRef}/dashboards/${dashboardId}?env=${environment}`);

export const dashboardsEditTools: McpToolDefinition[] = [
  defineWriteTool({
    name: "update_dashboard_widget",
    title: "Update Dashboard Widget",
    description:
      "Change one widget of a custom dashboard: its title, TRQL query, display, gap filling or grid position. Fields you leave out keep their current values; a new query replaces the whole query and is checked before saving. Use get_dashboard to see the widgets.",
    shape: UpdateDashboardWidgetInput.shape,
    approval: "configurable",
    auth,
    confirm: { preview: async (args, subject) => previewOf(await widgetPlan(args, subject)) },
    run: async (input, ctx) => {
      const environment = await subjectEnvironment(ctx);
      if (!environment) return plainError("Environment not found");

      const plan = await widgetPlan(input, ctx.subject);
      if ("refuse" in plan) return plainError(plan.refuse);
      return written(ctx, plan, async (revision) => {
        const row = await new MetricDashboardService().updateWidget({
          organizationId: environment.organizationId,
          friendlyId: input.dashboardId,
          widgetId: input.widgetId,
          changes: plan.changes,
          revision,
        });
        const title = toDashboardObject(row).widgets.find((w) => w.id === input.widgetId)?.title;
        const titled = title === undefined ? "" : `, now titled ${fenced(title, "widget-title")},`;
        return textResult(
          `Updated widget ${input.widgetId}${titled} on dashboard ${fenced(row.title, "dashboard-title")}.\n\n[View in dashboard](${viewUrl(environment.project.externalRef, row.friendlyId, input.environment)})`
        );
      });
    },
  }),
  defineWriteTool({
    name: "update_dashboard",
    title: "Update Dashboard",
    description:
      "Rename a custom dashboard or change its description. Its widgets are not changed; use update_dashboard_widget or set_dashboard_widgets for those.",
    shape: UpdateDashboardInput.shape,
    approval: "configurable",
    auth,
    confirm: { preview: async (args, subject) => previewOf(await updatePlan(args, subject)) },
    run: async (input, ctx) => {
      const environment = await subjectEnvironment(ctx);
      if (!environment) return plainError("Environment not found");

      return written(ctx, await updatePlan(input, ctx.subject), async (revision) => {
        const row = await new MetricDashboardService().update({
          organizationId: environment.organizationId,
          friendlyId: input.dashboardId,
          title: input.title,
          description: input.description,
          revision,
        });
        return textResult(
          `Updated dashboard ${fenced(row.title, "dashboard-title")} (${row.friendlyId}).\n\n[View in dashboard](${viewUrl(environment.project.externalRef, row.friendlyId, input.environment)})`
        );
      });
    },
  }),
  defineWriteTool({
    name: "delete_dashboard",
    title: "Delete Dashboard",
    description:
      "Delete a custom dashboard and all its widgets for everyone in the organization. The user approves the deletion in the Trigger.dev dashboard before it runs. It cannot be undone.",
    shape: DashboardRefInput.shape,
    approval: "required",
    auth,
    confirm: { preview: async (args, subject) => previewOf(await deletePlan(args, subject)) },
    run: async (input, ctx) => {
      const environment = await subjectEnvironment(ctx);
      if (!environment) return plainError("Environment not found");

      return written(ctx, await deletePlan(input, ctx.subject), async (revision) => {
        const row = await new MetricDashboardService().delete({
          organizationId: environment.organizationId,
          friendlyId: input.dashboardId,
          revision,
        });
        const deleted = `Deleted dashboard ${fenced(row.title, "dashboard-title")} (${row.friendlyId}).`;
        const notRemoved = textResult(
          `${deleted} Your side-menu favourite that links to it could not be removed; remove it by hand.`
        );
        try {
          const user = await getUserById(ctx.identity.userId);
          if (!user) return notRemoved;
          await removeFavoritesByUrlSubstring({
            user: { ...user, isImpersonating: false, isViewingAsUser: false },
            substring: `/dashboards/custom/${row.friendlyId}`,
          });
        } catch (error) {
          logger.error(
            `delete_dashboard: ${error instanceof Error ? error.message : String(error)}`
          );
          return notRemoved;
        }
        return textResult(deleted);
      });
    },
  }),
];
