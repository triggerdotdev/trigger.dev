import { type ActionFunctionArgs, redirect } from "@remix-run/node";
import { nanoid } from "nanoid";
import { z } from "zod";
import { typedjson } from "remix-typedjson";
import { prisma } from "~/db.server";
import { QueryWidgetConfig } from "~/components/metrics/QueryWidget";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { DashboardLayout } from "~/presenters/v3/MetricDashboardPresenter.server";
import { getCurrentPlan } from "~/services/platform.v3.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3CustomDashboardPath } from "~/utils/pathBuilder";

// Schemas for each action type
const AddWidgetSchema = z.object({
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

const RenameWidgetSchema = z.object({
  widgetId: z.string().min(1, "Widget ID is required"),
  title: z.string().min(1, "Title is required"),
});

const DeleteWidgetSchema = z.object({
  widgetId: z.string().min(1, "Widget ID is required"),
});

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

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
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
  const action = formData.get("action");

  // Parse existing layout (shared across all actions)
  let existingLayout: z.infer<typeof DashboardLayout>;
  try {
    const parsed = JSON.parse(dashboard.layout);
    const layoutResult = DashboardLayout.safeParse(parsed);
    if (!layoutResult.success) {
      // For add action, we can start with empty layout
      if (action === "add") {
        existingLayout = {
          version: "1",
          layout: [],
          widgets: {},
        };
      } else {
        throw new Response("Invalid dashboard layout", { status: 500 });
      }
    } else {
      existingLayout = layoutResult.data;
    }
  } catch (e) {
    if (e instanceof Response) throw e;
    if (action === "add") {
      existingLayout = {
        version: "1",
        layout: [],
        widgets: {},
      };
    } else {
      throw new Response("Failed to parse dashboard layout", { status: 500 });
    }
  }

  // Check widget limit for add/duplicate actions
  async function checkWidgetLimit() {
    const currentWidgetCount = Object.keys(existingLayout.widgets).length;
    const plan = await getCurrentPlan(project.organizationId);
    const metricWidgetsLimitValue = (plan?.v3Subscription?.plan?.limits as any)
      ?.metricWidgetsPerDashboard;
    const widgetLimit =
      typeof metricWidgetsLimitValue === "number"
        ? metricWidgetsLimitValue
        : (metricWidgetsLimitValue?.number ?? 16);

    if (currentWidgetCount >= widgetLimit) {
      throw new Response("Widget limit reached", { status: 403 });
    }
  }

  switch (action) {
    case "add": {
      await checkWidgetLimit();

      const rawData = {
        title: formData.get("title"),
        query: formData.get("query"),
        config: formData.get("config"),
      };

      const result = AddWidgetSchema.safeParse(rawData);
      if (!result.success) {
        throw new Response("Invalid form data: " + result.error.message, { status: 400 });
      }

      const { title, query, config } = result.data;

      // Generate new widget ID
      const widgetId = nanoid(8);

      // Calculate position at the bottom
      let maxBottom = 0;
      for (const item of existingLayout.layout) {
        const itemBottom = item.y + item.h;
        if (itemBottom > maxBottom) {
          maxBottom = itemBottom;
        }
      }

      // Add new layout item (full width, reasonable height)
      const newLayoutItem = {
        i: widgetId,
        x: 0,
        y: maxBottom,
        w: 12,
        h: 15,
      };

      // Add new widget
      const newWidget = {
        title,
        query,
        display: config,
      };

      // Update the layout
      const updatedLayout = {
        ...existingLayout,
        layout: [...existingLayout.layout, newLayoutItem],
        widgets: {
          ...existingLayout.widgets,
          [widgetId]: newWidget,
        },
      };

      // Save to database
      await prisma.metricsDashboard.update({
        where: { id: dashboard.id },
        data: {
          layout: JSON.stringify(updatedLayout),
        },
      });

      // Redirect to the dashboard
      const dashboardPath = v3CustomDashboardPath(
        { slug: organizationSlug },
        { slug: projectParam },
        { slug: envParam },
        { friendlyId: dashboardId }
      );
      return redirect(dashboardPath);
    }

    case "update": {
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

      return typedjson({ success: true, updatedTitle: title });
    }

    case "rename": {
      const rawData = {
        widgetId: formData.get("widgetId"),
        title: formData.get("title"),
      };

      const result = RenameWidgetSchema.safeParse(rawData);
      if (!result.success) {
        throw new Response("Invalid form data: " + result.error.message, { status: 400 });
      }

      const { widgetId, title } = result.data;

      // Check if widget exists
      if (!existingLayout.widgets[widgetId]) {
        throw new Response("Widget not found", { status: 404 });
      }

      // Update just the title
      const updatedLayout = {
        ...existingLayout,
        widgets: {
          ...existingLayout.widgets,
          [widgetId]: {
            ...existingLayout.widgets[widgetId],
            title,
          },
        },
      };

      // Save to database
      await prisma.metricsDashboard.update({
        where: { id: dashboard.id },
        data: {
          layout: JSON.stringify(updatedLayout),
        },
      });

      return typedjson({ success: true, renamedTitle: title });
    }

    case "delete": {
      const rawData = {
        widgetId: formData.get("widgetId"),
      };

      const result = DeleteWidgetSchema.safeParse(rawData);
      if (!result.success) {
        throw new Response("Invalid form data: " + result.error.message, { status: 400 });
      }

      const { widgetId } = result.data;

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
    }

    case "duplicate": {
      await checkWidgetLimit();

      const rawData = {
        widgetId: formData.get("widgetId"),
      };

      const result = DuplicateWidgetSchema.safeParse(rawData);
      if (!result.success) {
        throw new Response("Invalid form data: " + result.error.message, { status: 400 });
      }

      const { widgetId } = result.data;

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
    }

    default: {
      throw new Response("Invalid action", { status: 400 });
    }
  }
};
