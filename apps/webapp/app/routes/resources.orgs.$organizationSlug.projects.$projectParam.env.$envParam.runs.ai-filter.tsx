import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { type TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";

const RequestSchema = z.object({
  text: z.string().min(1),
});

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  // Parse the request body
  const formData = await request.formData();
  const submission = RequestSchema.safeParse(Object.fromEntries(formData));

  if (!submission.success) {
    return json<{ success: false; error: string }>(
      {
        success: false,
        error: "Invalid request data",
      },
      { status: 400 }
    );
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  const { text } = submission.data;

  // TODO: Replace this with actual AI processing
  // For now, return fake successful data
  const fakeFilters: TaskRunListSearchFilters = {
    statuses: ["COMPLETED_WITH_ERRORS", "COMPLETED_SUCCESSFULLY"],
    machines: ["small-2x"],
    period: "7d",
  };

  return json<{ success: true; filters: TaskRunListSearchFilters; explanation: string }>({
    success: true,
    filters: fakeFilters,
    explanation: `Applied filters: failed status, last 7 days, with tag "test-tag"`,
  });
}
