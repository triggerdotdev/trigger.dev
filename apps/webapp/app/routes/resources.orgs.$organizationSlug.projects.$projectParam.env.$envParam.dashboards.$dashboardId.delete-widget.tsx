import { type ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { typedjson } from "remix-typedjson";
import { prisma } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { DashboardLayout } from "~/presenters/v3/MetricDashboardPresenter.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

const DeleteWidgetSchema = z.object({
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

  const result = DeleteWidgetSchema.safeParse(rawData);
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

  // Get widget title before deleting (for the success message)
  const widget = existingLayout.widgets[widgetId];
  const widgetTitle = widget?.title ?? "Widget";

  // Remove widget from layout and widgets
  const updatedLayout = {
    ...existingLayout,
    layout: existingLayout.layout.filter((item) => item.i !== widgetId),
    widgets: Object.fromEntries(
      Object.entries(existingLayout.widgets).filter(([key]) => key !== widgetId)
    ),
  };

  // Save to database
  await prisma.metricsDashboard.update({
    where: { id: dashboard.id },
    data: {
      layout: JSON.stringify(updatedLayout),
    },
  });

  return typedjson({ success: true, deletedTitle: widgetTitle });
};
