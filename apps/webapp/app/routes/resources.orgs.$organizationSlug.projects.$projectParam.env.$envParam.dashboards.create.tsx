import { redirect, type ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { prisma } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { getCurrentPlan } from "~/services/platform.v3.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3CustomDashboardPath } from "~/utils/pathBuilder";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";

const CreateDashboardSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional().default(""),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  // Check dashboard limit
  const [plan, existingCount] = await Promise.all([
    getCurrentPlan(project.organizationId),
    prisma.metricsDashboard.count({
      where: { organizationId: project.organizationId },
    }),
  ]);

  const metricDashboardsLimitValue = (plan?.v3Subscription?.plan?.limits as any)
    ?.metricDashboards;
  const dashboardLimit =
    typeof metricDashboardsLimitValue === "number"
      ? metricDashboardsLimitValue
      : (metricDashboardsLimitValue?.number ?? 3);

  if (existingCount >= dashboardLimit) {
    throw new Response("Dashboard limit reached", { status: 403 });
  }

  const formData = await request.formData();
  const rawData = {
    title: formData.get("title"),
    description: formData.get("description") ?? "",
  };

  const result = CreateDashboardSchema.safeParse(rawData);
  if (!result.success) {
    throw new Response("Invalid form data", { status: 400 });
  }

  const { title, description } = result.data;

  // Create empty default layout
  const defaultLayout = JSON.stringify({
    version: "1",
    layout: [],
    widgets: {},
  });

  const dashboard = await prisma.metricsDashboard.create({
    data: {
      friendlyId: generateFriendlyId("dashboard"),
      title,
      description,
      organizationId: project.organizationId,
      projectId: project.id,
      ownerId: userId,
      layout: defaultLayout,
    },
  });

  // Redirect to the new dashboard
  return redirect(
    v3CustomDashboardPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam },
      { friendlyId: dashboard.friendlyId }
    )
  );
};
