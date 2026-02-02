import { redirect, type ActionFunctionArgs } from "@remix-run/node";
import { nanoid } from "nanoid";
import { z } from "zod";
import { prisma } from "~/db.server";
import { QueryWidgetConfig } from "~/components/metrics/QueryWidget";
import { findProjectBySlug } from "~/models/project.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3CustomDashboardPath } from "~/utils/pathBuilder";

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

const ParamsSchema = EnvironmentParamSchema.extend({
  dashboardId: z.string(),
});

// Layout item schema for parsing existing layout
const LayoutItemSchema = z.object({
  i: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

const WidgetSchema = z.object({
  title: z.string(),
  query: z.string(),
  display: QueryWidgetConfig,
});

const DashboardLayoutSchema = z.object({
  version: z.literal("1"),
  layout: z.array(LayoutItemSchema),
  widgets: z.record(WidgetSchema),
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
    title: formData.get("title"),
    query: formData.get("query"),
    config: formData.get("config"),
  };

  const result = AddWidgetSchema.safeParse(rawData);
  if (!result.success) {
    throw new Response("Invalid form data: " + result.error.message, { status: 400 });
  }

  const { title, query, config } = result.data;

  // Parse existing layout
  let existingLayout: z.infer<typeof DashboardLayoutSchema>;
  try {
    const parsed = JSON.parse(dashboard.layout);
    const layoutResult = DashboardLayoutSchema.safeParse(parsed);
    if (!layoutResult.success) {
      // If parsing fails, start with empty layout
      existingLayout = {
        version: "1",
        layout: [],
        widgets: {},
      };
    } else {
      existingLayout = layoutResult.data;
    }
  } catch {
    existingLayout = {
      version: "1",
      layout: [],
      widgets: {},
    };
  }

  // Generate new widget ID
  const widgetId = nanoid(8);

  // Calculate position at the bottom
  // Find the maximum y + h from existing layout items
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
  return redirect(
    v3CustomDashboardPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam },
      { friendlyId: dashboardId }
    )
  );
};
