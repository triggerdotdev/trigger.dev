import { type ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { prisma } from "~/db.server";
import { QueryWidgetConfig } from "~/components/metrics/QueryWidget";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { DashboardLayout } from "~/presenters/v3/MetricDashboardPresenter.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3CustomDashboardPath } from "~/utils/pathBuilder";

const UpdateWidgetSchema = z.object({
  widgetId: z.string().min(1, "Widget ID is required"),
  title: z.string().min(1, "Title is required"),
  query: z.string().min(1, "Query is required"),
  config: z.string().transform((str, ctx) => {
    try {
      const parsed = JSON.parse(str);
      const result = QueryWidgetConfig.safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid widget config",
        });
        return z.NEVER;
      }
      return result.data;
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid JSON",
      });
      return z.NEVER;
    }
  }),
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
    title: formData.get("title"),
    query: formData.get("query"),
    config: formData.get("config"),
  };

  const result = UpdateWidgetSchema.safeParse(rawData);
  if (!result.success) {
    throw new Response("Invalid form data: " + result.error.message, { status: 400 });
  }

  const { widgetId, title, query, config } = result.data;

  // Parse existing layout
  let existingLayout: z.infer<typeof DashboardLayout>;
  try {
    const parsed = JSON.parse(dashboard.layout);
    const layoutResult = DashboardLayout.safeParse(parsed);
    if (!layoutResult.success) {
      throw new Response("Dashboard layout is corrupt", { status: 500 });
    }
    existingLayout = layoutResult.data;
  } catch (e) {
    if (e instanceof Response) throw e;
    throw new Response("Failed to parse dashboard layout", { status: 500 });
  }

  // Check if widget exists
  if (!existingLayout.widgets[widgetId]) {
    throw new Response("Widget not found", { status: 404 });
  }

  // Update the widget
  const updatedWidget = {
    title,
    query,
    display: config,
  };

  // Update the layout
  const updatedLayout = {
    ...existingLayout,
    widgets: {
      ...existingLayout.widgets,
      [widgetId]: updatedWidget,
    },
  };

  // Save to database
  await prisma.metricsDashboard.update({
    where: { id: dashboard.id },
    data: {
      layout: JSON.stringify(updatedLayout),
    },
  });

  // Redirect with _revalidate param to trigger revalidation on the dashboard page
  const dashboardPath = v3CustomDashboardPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam },
    { friendlyId: dashboardId }
  );

  return redirectWithSuccessMessage(
    `${dashboardPath}?_revalidate=${Date.now()}`,
    request,
    `Updated "${title}"`
  );
};
