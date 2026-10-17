import { compileTSQL } from "@internal/tsql";
import {
  DashboardDefinition,
  type DashboardLayoutItem,
  type DashboardObject,
  type DashboardStoredWidget,
  type DashboardSummary,
  type DashboardWidget,
  type DashboardWidgetDisplay,
  type DashboardWidgetInput,
  type DashboardWidgetPosition,
} from "@trigger.dev/core/v3/schemas";
import type { MetricsDashboard } from "@trigger.dev/database";
import { json } from "@remix-run/server-runtime";
import type { z } from "zod";
import { nanoid } from "nanoid";
import { $transaction, prisma, type PrismaClientOrTransaction } from "~/db.server";
import { getCurrentPlan } from "~/services/platform.v3.server";
import { querySchemas } from "~/v3/querySchemas";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import { ServiceValidationError } from "./common.server";

export type DashboardLimits = {
  dashboards: number;
  widgetsPerDashboard: number;
};

/** The org's plan limits for custom dashboards, with the defaults the dashboard has always used. */
async function getDashboardLimits(organizationId: string): Promise<DashboardLimits> {
  const plan = await getCurrentPlan(organizationId);
  const limits = plan?.v3Subscription?.plan?.limits as Record<string, unknown> | undefined;

  return {
    dashboards: limitNumber(limits?.metricDashboards, 3),
    widgetsPerDashboard: limitNumber(limits?.metricWidgetsPerDashboard, 16),
  };
}

function limitNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "number" in value && typeof value.number === "number") {
    return value.number;
  }
  return fallback;
}

const EMPTY_DASHBOARD_DEFINITION: DashboardDefinition = {
  version: "1",
  layout: [],
  widgets: {},
};

const FULL_WIDTH = 12;
const CHART_HEIGHT = 15;
const TITLE_HEIGHT = 2;

/** A widget's display type and query, checked the same way for the dashboard and the API. */
type WidgetContent = {
  title: string;
  query: string;
  display: DashboardWidgetDisplay;
  fillGaps?: boolean;
};

type DashboardRef = { organizationId: string; friendlyId: string };

type WidgetInput = z.output<typeof DashboardWidgetInput>;

export class MetricDashboardService {
  constructor(
    private readonly _prisma: PrismaClientOrTransaction = prisma,
    private readonly _limits: (
      organizationId: string
    ) => Promise<DashboardLimits> = getDashboardLimits
  ) {}

  async list(organizationId: string) {
    return this._prisma.metricsDashboard.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
    });
  }

  async get({ organizationId, friendlyId }: DashboardRef) {
    const dashboard = await this._prisma.metricsDashboard.findFirst({
      where: { organizationId, friendlyId },
    });

    if (!dashboard) {
      throw new ServiceValidationError("Dashboard not found", 404);
    }

    return dashboard;
  }

  async create({
    organizationId,
    projectId,
    ownerId,
    title,
    description,
    widgets,
  }: {
    organizationId: string;
    projectId: string;
    ownerId?: string | null;
    title: string;
    description?: string;
    widgets?: WidgetInput[];
  }) {
    const limits = await this._limits(organizationId);
    const definition = widgets ? buildDefinition(widgets) : EMPTY_DASHBOARD_DEFINITION;
    assertWidgetLimit(definition, limits);

    const dashboard = await $transaction(this._prisma, "metricDashboard.create", async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`metrics_dashboard:${organizationId}`}))`;

      const existing = await tx.metricsDashboard.count({ where: { organizationId } });
      if (existing >= limits.dashboards) {
        throw new ServiceValidationError("Dashboard limit reached", 403);
      }

      return tx.metricsDashboard.create({
        data: {
          friendlyId: generateFriendlyId("dashboard"),
          title,
          description: description ?? "",
          organizationId,
          projectId,
          ownerId: ownerId ?? null,
          layout: JSON.stringify(definition),
        },
      });
    });

    if (!dashboard) {
      throw new Error("Failed to create dashboard");
    }

    return dashboard;
  }

  async update({
    organizationId,
    friendlyId,
    title,
    description,
    revision,
  }: DashboardRef & { title?: string; description?: string; revision?: string }) {
    const dashboard = await this.get({ organizationId, friendlyId });
    assertRevision(dashboard, revision);

    return this.#write(
      dashboard,
      {
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
      },
      revision !== undefined
    );
  }

  async replace({
    organizationId,
    friendlyId,
    title,
    description,
    widgets,
    revision,
  }: DashboardRef & {
    title?: string;
    description?: string;
    widgets: WidgetInput[];
    revision?: string;
  }) {
    const dashboard = await this.get({ organizationId, friendlyId });
    assertRevision(dashboard, revision);

    const previous = parseDefinition(dashboard.layout);
    const definition = buildDefinition(widgets, previous);
    assertWidgetLimit(definition, await this._limits(organizationId));

    return this.#write(
      dashboard,
      {
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        layout: JSON.stringify(definition),
      },
      true
    );
  }

  async delete({ organizationId, friendlyId }: DashboardRef) {
    const dashboard = await this.get({ organizationId, friendlyId });

    await this._prisma.metricsDashboard.delete({ where: { id: dashboard.id } });

    return dashboard;
  }

  async addWidget({
    organizationId,
    friendlyId,
    widget,
    revision,
  }: DashboardRef & { widget: WidgetInput; revision?: string }) {
    const dashboard = await this.get({ organizationId, friendlyId });
    assertRevision(dashboard, revision);

    const definition = parseDefinitionOrEmpty(dashboard.layout);
    const content = widgetContent(widget);

    if (content.display.type !== "title") {
      assertWidgetLimit(definition, await this._limits(organizationId), 1);
    }

    const widgetId = widget.id || nanoid(8);
    if (definition.widgets[widgetId]) {
      throw new ServiceValidationError(`A widget with id "${widgetId}" already exists`, 409);
    }

    const updated: DashboardDefinition = {
      ...definition,
      layout: [
        ...definition.layout,
        widget.position
          ? { i: widgetId, ...widget.position }
          : bottomLayoutItem(definition, widgetId, content.display),
      ],
      widgets: { ...definition.widgets, [widgetId]: storedWidget(content) },
    };

    const saved = await this.#saveDefinition(dashboard, updated);
    return { dashboard: saved, widgetId };
  }

  async updateWidget({
    organizationId,
    friendlyId,
    widgetId,
    changes,
    revision,
  }: DashboardRef & {
    widgetId: string;
    changes: {
      title?: string;
      query?: string;
      display?: DashboardWidgetDisplay;
      fillGaps?: boolean;
      position?: DashboardWidgetPosition;
    };
    revision?: string;
  }) {
    const dashboard = await this.get({ organizationId, friendlyId });
    assertRevision(dashboard, revision);

    const definition = parseDefinition(dashboard.layout);
    const existing = definition.widgets[widgetId];
    if (!existing) {
      throw new ServiceValidationError("Widget not found", 404);
    }

    const content = widgetContent({
      title: changes.title ?? existing.title,
      query: changes.query ?? existing.query,
      display: changes.display ?? existing.display,
      fillGaps: changes.fillGaps ?? existing.fillGaps,
    });

    if (existing.display.type === "title" && content.display.type !== "title") {
      assertWidgetLimit(definition, await this._limits(organizationId), 1);
    }

    const updated: DashboardDefinition = {
      ...definition,
      layout: changes.position
        ? withPosition(definition.layout, widgetId, changes.position)
        : definition.layout,
      widgets: { ...definition.widgets, [widgetId]: storedWidget(content) },
    };

    return this.#saveDefinition(dashboard, updated);
  }

  async deleteWidget({
    organizationId,
    friendlyId,
    widgetId,
    revision,
    requireExisting = false,
  }: DashboardRef & { widgetId: string; revision?: string; requireExisting?: boolean }) {
    const dashboard = await this.get({ organizationId, friendlyId });
    assertRevision(dashboard, revision);

    const definition = parseDefinition(dashboard.layout);
    const existing = definition.widgets[widgetId];
    if (!existing && requireExisting) {
      throw new ServiceValidationError("Widget not found", 404);
    }

    const updated: DashboardDefinition = {
      ...definition,
      layout: definition.layout.filter((item) => item.i !== widgetId),
      widgets: Object.fromEntries(
        Object.entries(definition.widgets).filter(([key]) => key !== widgetId)
      ),
    };

    const saved = await this.#saveDefinition(dashboard, updated);
    return { dashboard: saved, deleted: existing };
  }

  async duplicateWidget({
    organizationId,
    friendlyId,
    widgetId,
    newWidgetId,
  }: DashboardRef & { widgetId: string; newWidgetId?: string | null }) {
    const dashboard = await this.get({ organizationId, friendlyId });
    const definition = parseDefinition(dashboard.layout);
    assertWidgetLimit(definition, await this._limits(organizationId), 1);

    const original = definition.widgets[widgetId];
    if (!original) {
      throw new ServiceValidationError("Widget not found", 404);
    }

    const originalItem = definition.layout.find((item) => item.i === widgetId);
    if (!originalItem) {
      throw new ServiceValidationError("Widget layout not found", 404);
    }

    const copyId = newWidgetId || nanoid(8);
    if (definition.widgets[copyId]) {
      throw new ServiceValidationError(`A widget with id "${copyId}" already exists`, 409);
    }
    const updated: DashboardDefinition = {
      ...definition,
      layout: [
        ...definition.layout,
        {
          i: copyId,
          x: 0,
          y: layoutBottom(definition.layout),
          w: originalItem.w,
          h: originalItem.h,
        },
      ],
      widgets: {
        ...definition.widgets,
        [copyId]: { ...original, title: `${original.title} (Copy)` },
      },
    };

    const saved = await this.#saveDefinition(dashboard, updated);
    return { dashboard: saved, original };
  }

  async saveLayout({
    organizationId,
    friendlyId,
    layout,
  }: DashboardRef & { layout: DashboardLayoutItem[] }) {
    const dashboard = await this.get({ organizationId, friendlyId });
    const definition = parseDefinition(dashboard.layout);

    return this.#saveDefinition(dashboard, { ...definition, layout });
  }

  async #saveDefinition(dashboard: MetricsDashboard, definition: DashboardDefinition) {
    return this.#write(dashboard, { layout: JSON.stringify(definition) }, true);
  }

  /**
   * Writes the dashboard. A conditional write only succeeds if nobody changed it since it was
   * read, which keeps two read-modify-write edits from silently overwriting each other.
   */
  async #write(
    dashboard: MetricsDashboard,
    data: { title?: string; description?: string; layout?: string },
    conditional: boolean
  ) {
    const result = await this._prisma.metricsDashboard.updateMany({
      where: conditional
        ? { id: dashboard.id, updatedAt: dashboard.updatedAt }
        : { id: dashboard.id },
      data,
    });

    if (result.count === 0) {
      throw new ServiceValidationError(
        "Dashboard was modified by another request. Please refresh and try again.",
        409
      );
    }

    return this._prisma.metricsDashboard.findFirstOrThrow({ where: { id: dashboard.id } });
  }
}

/** Parses a stored definition, failing the request if it is corrupt. */
function parseDefinition(layout: string): DashboardDefinition {
  let json: unknown;
  try {
    json = JSON.parse(layout);
  } catch {
    throw new ServiceValidationError("Failed to parse dashboard layout", 500);
  }

  const result = DashboardDefinition.safeParse(json);
  if (!result.success) {
    throw new ServiceValidationError("Invalid dashboard layout", 500);
  }

  return result.data;
}

function parseDefinitionOrEmpty(layout: string): DashboardDefinition {
  try {
    return parseDefinition(layout);
  } catch {
    return EMPTY_DASHBOARD_DEFINITION;
  }
}

function assertRevision(dashboard: MetricsDashboard, revision: string | undefined) {
  if (revision !== undefined && revision !== dashboardRevision(dashboard)) {
    throw new ServiceValidationError(
      "Dashboard was modified by another request. Fetch it again and retry with the new revision.",
      409
    );
  }
}

export function dashboardRevision(dashboard: Pick<MetricsDashboard, "updatedAt">): string {
  return dashboard.updatedAt.toISOString();
}

function countedWidgets(definition: DashboardDefinition): number {
  return Object.values(definition.widgets).filter((w) => w.display.type !== "title").length;
}

function assertWidgetLimit(definition: DashboardDefinition, limits: DashboardLimits, adding = 0) {
  if (countedWidgets(definition) + adding > limits.widgetsPerDashboard) {
    throw new ServiceValidationError("Widget limit reached", 403);
  }
}

function widgetContent(widget: {
  title: string;
  query?: string;
  display: DashboardWidgetDisplay;
  fillGaps?: boolean;
}): WidgetContent {
  const query = widget.query ?? "";

  if (widget.display.type !== "title" && !query) {
    throw new ServiceValidationError("Query is required for chart widgets", 400);
  }

  return { title: widget.title, query, display: widget.display, fillGaps: widget.fillGaps };
}

function storedWidget(content: WidgetContent): DashboardStoredWidget {
  return {
    title: content.title,
    query: content.query,
    display: content.display,
    ...(content.fillGaps !== undefined ? { fillGaps: content.fillGaps } : {}),
  };
}

function layoutBottom(layout: DashboardLayoutItem[]): number {
  return layout.reduce((bottom, item) => Math.max(bottom, item.y + item.h), 0);
}

function bottomLayoutItem(
  definition: DashboardDefinition,
  widgetId: string,
  display: DashboardWidgetDisplay
): DashboardLayoutItem {
  return {
    i: widgetId,
    x: 0,
    y: layoutBottom(definition.layout),
    w: FULL_WIDTH,
    h: display.type === "title" ? TITLE_HEIGHT : CHART_HEIGHT,
  };
}

function withPosition(
  layout: DashboardLayoutItem[],
  widgetId: string,
  position: DashboardWidgetPosition
): DashboardLayoutItem[] {
  const exists = layout.some((item) => item.i === widgetId);
  if (!exists) {
    return [...layout, { i: widgetId, ...position }];
  }
  return layout.map((item) => (item.i === widgetId ? { ...item, ...position } : item));
}

/**
 * Builds a definition from a full list of widgets. A widget that already exists keeps its stored
 * position unless a new one is given; new widgets without a position stack full width below the
 * placed ones, in the order given.
 */
function buildDefinition(
  widgets: WidgetInput[],
  previous?: DashboardDefinition
): DashboardDefinition {
  const ids = new Set<string>();
  const entries = widgets.map((widget) => {
    const id = widget.id || nanoid(8);
    if (ids.has(id)) {
      throw new ServiceValidationError(`Duplicate widget id "${id}"`, 400);
    }
    ids.add(id);
    return { id, widget, content: widgetContent(widget) };
  });

  const layout: DashboardLayoutItem[] = [];
  const placed = new Set<string>();
  for (const { id, widget } of entries) {
    const existing = previous?.layout.find((item) => item.i === id);
    if (widget.position) {
      layout.push({ ...(existing ?? {}), i: id, ...widget.position });
      placed.add(id);
    } else if (existing) {
      layout.push(existing);
      placed.add(id);
    }
  }

  let bottom = layoutBottom(layout);
  for (const { id, content } of entries) {
    if (!placed.has(id)) {
      const h = content.display.type === "title" ? TITLE_HEIGHT : CHART_HEIGHT;
      layout.push({ i: id, x: 0, y: bottom, w: FULL_WIDTH, h });
      bottom += h;
    }
  }

  return {
    version: "1",
    layout,
    widgets: Object.fromEntries(entries.map(({ id, content }) => [id, storedWidget(content)])),
  };
}

/**
 * Checks every non-title widget's query compiles as TRQL against the queryable tables, so a broken
 * query, table or column is rejected when it is saved rather than when the chart first renders.
 * Nothing is executed.
 */
export function assertValidWidgetQueries(
  widgets: Array<{ id?: string; title: string; query?: string; display: DashboardWidgetDisplay }>
) {
  for (const widget of widgets) {
    if (widget.display.type === "title" || !widget.query) continue;

    try {
      compileTSQL(widget.query, {
        tableSchema: querySchemas,
        enforcedWhereClause: {
          organization_id: { op: "eq", value: "validation" },
          project_id: { op: "eq", value: "validation" },
          environment_id: { op: "eq", value: "validation" },
        },
        timeRange: { from: new Date(Date.now() - 86_400_000), to: new Date() },
      });
    } catch (error) {
      const label = widget.id ? `"${widget.id}"` : `"${widget.title}"`;
      const reason = error instanceof Error ? error.message : String(error);
      throw new ServiceValidationError(`Widget ${label} has an invalid query: ${reason}`, 400);
    }
  }
}

/** The dashboards API's view of a stored dashboard. */
export function toDashboardObject(dashboard: MetricsDashboard): DashboardObject {
  const definition = parseDefinitionOrEmpty(dashboard.layout);
  const positions = new Map(definition.layout.map((item) => [item.i, item]));
  let fallbackY = layoutBottom(definition.layout);

  const widgets: DashboardWidget[] = Object.entries(definition.widgets).map(([id, widget]) => {
    const item = positions.get(id);
    const position = item
      ? { x: item.x, y: item.y, w: item.w, h: item.h }
      : { x: 0, y: fallbackY, w: FULL_WIDTH, h: CHART_HEIGHT };
    if (!item) fallbackY += CHART_HEIGHT;

    return {
      id,
      title: widget.title,
      query: widget.query,
      display: widget.display,
      ...(widget.fillGaps !== undefined ? { fillGaps: widget.fillGaps } : {}),
      position,
    };
  });

  widgets.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);

  return {
    id: dashboard.friendlyId,
    title: dashboard.title,
    description: dashboard.description,
    revision: dashboardRevision(dashboard),
    createdAt: dashboard.createdAt,
    updatedAt: dashboard.updatedAt,
    widgets,
  };
}

/** The list entry for a custom dashboard, in the same shape as the built-in dashboards. */
export function toDashboardSummary(dashboard: MetricsDashboard): DashboardSummary {
  const definition = parseDefinitionOrEmpty(dashboard.layout);

  return {
    key: dashboard.friendlyId,
    title: dashboard.title,
    type: "custom",
    description: dashboard.description,
    widgets: Object.entries(definition.widgets)
      .filter(([, widget]) => widget.display.type !== "title")
      .map(([id, widget]) => ({
        id,
        title: widget.title,
        query: widget.query,
        type: widget.display.type,
      })),
  };
}

/** Maps a dashboard service error to the API's `{ error }` response, or rethrows anything else. */
export function dashboardApiErrorResponse(error: unknown): Response {
  if (error instanceof ServiceValidationError) {
    return json({ error: error.message }, { status: error.status ?? 400 });
  }
  throw error;
}
