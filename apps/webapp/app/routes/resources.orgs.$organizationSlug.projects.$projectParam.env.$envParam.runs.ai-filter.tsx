import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { processAIFilter } from "~/v3/services/aiRunFilterService.server";
import { type TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";

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

  const result = await processAIFilter(text, environment.id);

  if (result.success) {
    return json(result);
  } else {
    return json(result, { status: 400 });
  }
}
