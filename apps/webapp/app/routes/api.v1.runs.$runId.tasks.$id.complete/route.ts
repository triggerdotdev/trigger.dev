import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { CompleteTaskBodyOutput } from "@trigger.dev/core";
import {
  API_VERSIONS,
  CompleteTaskBodyInputSchema,
  CompleteTaskBodyV2InputSchema,
} from "@trigger.dev/core";
import { z } from "zod";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { CompleteRunTaskService } from "./CompleteRunTaskService.server";

const ParamsSchema = z.object({
  runId: z.string(),
  id: z.string(),
});

const HeadersSchema = z.object({
  "trigger-version": z.string().optional().nullable(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const authenticatedEnv = authenticationResult.environment;

  const { runId, id } = ParamsSchema.parse(params);

  const headers = HeadersSchema.safeParse(Object.fromEntries(request.headers));

  if (!headers.success) {
    return json({ error: "Invalid headers" }, { status: 400 });
  }

  const { "trigger-version": triggerVersion } = headers.data;

  // Now parse the request body
  const anyBody = await request.json();

  logger.debug("CompleteRunTaskService.call() request body", {
    body: anyBody,
    runId,
    id,
  });

  if (triggerVersion === API_VERSIONS.SERIALIZED_TASK_OUTPUT) {
    const body = CompleteTaskBodyV2InputSchema.safeParse(anyBody);

    if (!body.success) {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    // Make sure the length of the output is less than 3MB
    if (body.data.output && body.data.output.length > 3 * 1024 * 1024) {
      return json({ error: "Output must be less than 3MB" }, { status: 400 });
    }

    return await completeRunTask(authenticatedEnv, runId, id, {
      ...body.data,
      output: body.data.output ? (JSON.parse(body.data.output) as any) : undefined,
    });
  } else {
    const body = CompleteTaskBodyInputSchema.safeParse(anyBody);

    if (!body.success) {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    // Make sure the length of the output is less than 3MB
    if (JSON.stringify(body.data.output).length > 3 * 1024 * 1024) {
      return json({ error: "Output must be less than 3MB" }, { status: 400 });
    }

    return await completeRunTask(authenticatedEnv, runId, id, body.data);
  }
}

async function completeRunTask(
  environment: AuthenticatedEnvironment,
  runId: string,
  id: string,
  taskBody: CompleteTaskBodyOutput
) {
  const service = new CompleteRunTaskService();

  try {
    const task = await service.call(environment, runId, id, taskBody);

    logger.debug("CompleteRunTaskService.call() response body", {
      runId,
      id,
      task,
    });

    if (!task) {
      return json({ message: "Task not found" }, { status: 404 });
    }

    return json(task);
  } catch (error) {
    if (error instanceof Error) {
      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
