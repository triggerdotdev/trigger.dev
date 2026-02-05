import { type ActionFunctionArgs } from "@remix-run/node";
import { nanoid } from "nanoid";
import { z } from "zod";
import { typedjson } from "remix-typedjson";
import { prisma } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { DashboardLayout } from "~/presenters/v3/MetricDashboardPresenter.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

const DuplicateWidgetSchema = z.object({
  widgetId: z.string().min(1, "Widget ID is required"),
});

const ParamsSchema = EnvironmentParamSchema.extend({
  dashboardId: z.string(),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, dashboardId } = ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  // Load the dashboard
  const dashboard = await prisma.metricsDashboard.findFirst({
    where: {
      friendlyId: dashboardId,
      organizationId: project.organizationId,
    },
  });

  if (!dashboard) {
    throw new Response("Dashboard not found", { status: 404 });
  }

  const formData = await request.formData();
  const rawData = {
    widgetId: formData.get("widgetId"),
  };

  const result = DuplicateWidgetSchema.safeParse(rawData);
  if (!result.success) {
    throw new Response("Invalid form data: " + result.error.message, { status: 400 });
  }

  const { widgetId } = result.data;

  // Parse existing layout
  let existingLayout: z.infer<typeof DashboardLayout>;
  try {
    const parsed = JSON.parse(dashboard.layout);
    const layoutResult = DashboardLayout.safeParse(parsed);
    if (!layoutResult.success) {
      throw new Response("Invalid dashboard layout", { status: 500 });
    }
    existingLayout = layoutResult.data;
  } catch {
    throw new Response("Failed to parse dashboard layout", { status: 500 });
  }

  // Find the original widget
  const originalWidget = existingLayout.widgets[widgetId];
  if (!originalWidget) {
    throw new Response("Widget not found", { status: 404 });
  }

  // Find the original layout item
  const originalLayoutItem = existingLayout.layout.find((item) => item.i === widgetId);
  if (!originalLayoutItem) {
    throw new Response("Widget layout not found", { status: 404 });
  }

  // Generate new widget ID
  const newWidgetId = nanoid(8);

  // Calculate position at the bottom
  let maxBottom = 0;
  for (const item of existingLayout.layout) {
    const itemBottom = item.y + item.h;
    if (itemBottom > maxBottom) {
      maxBottom = itemBottom;
    }
  }

  // Create new layout item with same dimensions but at the bottom
  const newLayoutItem = {
    i: newWidgetId,
    x: 0,
    y: maxBottom,
    w: originalLayoutItem.w,
    h: originalLayoutItem.h,
  };

  // Create new widget with "(Copy)" suffix
  const newWidget = {
    ...originalWidget,
    title: `${originalWidget.title} (Copy)`,
  };

  // Update the layout
  const updatedLayout = {
    ...existingLayout,
    layout: [...existingLayout.layout, newLayoutItem],
    widgets: {
      ...existingLayout.widgets,
      [newWidgetId]: newWidget,
    },
  };

  // Save to database
  await prisma.metricsDashboard.update({
    where: { id: dashboard.id },
    data: {
      layout: JSON.stringify(updatedLayout),
    },
  });

  return typedjson({ success: true, duplicatedTitle: originalWidget.title });
};
