import { openai } from "@ai-sdk/openai";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { z } from "zod";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { findProjectById } from "~/models/project.server";
import { findEnvironmentInProject } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { AI } from "~/v3/services/ai.server";

const RequestSchema = z.object({
  prompt: z.string().optional(),
});

const EnvironmentParamSchema = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  envId: z.string(),
  taskIdentifier: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationId, projectId, envId, taskIdentifier } = EnvironmentParamSchema.parse(params);

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

  const project = await findProjectById(organizationId, projectId, userId);
  if (!project) {
    return json<{ success: false; error: string }>(
      {
        success: false,
        error: "Project not found",
      },
      { status: 400 }
    );
  }

  const environment = await findEnvironmentInProject(project.id, envId);
  if (!environment) {
    return json<{ success: false; error: string }>(
      {
        success: false,
        error: "Environment not found",
      },
      { status: 400 }
    );
  }

  const backgroundTask = await $replica.backgroundWorkerTask.findFirst({
    where: {
      friendlyId: taskIdentifier,
      runtimeEnvironmentId: environment.id,
    },
  });

  if (!backgroundTask) {
    return json<{ success: false; error: string }>(
      {
        success: false,
        error: "Task not found",
      },
      { status: 400 }
    );
  }

  const { prompt } = submission.data;

  if (!env.OPENAI_API_KEY) {
    return json(
      {
        success: false,
        error: "OpenAI API key is not configured",
      },
      { status: 400 }
    );
  }

  const service = new AI(openai(env.AI_RUN_FILTER_MODEL ?? "gpt-4o-mini"));

  const [error, result] = await tryCatch(
    service.tasks.generateTextPayload({
      prompt,
      backgroundTask,
    })
  );

  if (error) {
    return json({ success: false, error: error.message }, { status: 400 });
  }

  if (!result.ok) {
    return json({ success: false, error: result.error }, { status: 400 });
  }

  return json({
    success: true,
    payload: result.payload,
  });
}
