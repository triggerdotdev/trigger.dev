import { redirect, type ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { findProjectBySlug } from "~/models/project.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3CustomDashboardPath } from "~/utils/pathBuilder";
import { ServiceValidationError } from "~/v3/services/common.server";
import { MetricDashboardService } from "~/v3/services/metricDashboard.server";
import { tryCatch } from "@trigger.dev/core/utils";

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

  const [error, dashboard] = await tryCatch(
    new MetricDashboardService().create({
      organizationId: project.organizationId,
      projectId: project.id,
      ownerId: userId,
      title,
      description,
    })
  );

  if (error) {
    if (error instanceof ServiceValidationError) {
      throw new Response(error.message, { status: error.status ?? 400 });
    }
    throw error;
  }

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
