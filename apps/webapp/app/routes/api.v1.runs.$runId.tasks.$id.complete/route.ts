import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { CompleteTaskBodyOutput } from "@trigger.dev/core/schemas";
import {
  CompleteTaskBodyInputSchema,
  CompleteTaskBodyV2InputSchema,
} from "@trigger.dev/core/schemas";
import { z } from "zod";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { CompleteRunTaskService } from "./CompleteRunTaskService.server";
import { startActiveSpan } from "~/v3/tracer.server";
import { parseRequestJsonAsync } from "~/utils/parseRequestJson.server";
import { FailRunTaskService } from "../api.v1.runs.$runId.tasks.$id.fail/FailRunTaskService.server";

const API_VERSIONS = {
  LAZY_LOADED_CACHED_TASKS: "2023-09-29",
  SERIALIZED_TASK_OUTPUT: "2023-11-01",
};

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

  // Check the content size of the request and make sure it's not too large
  const contentLength = request.headers.get("content-length");

  if (!contentLength || parseInt(contentLength) > 3 * 1024 * 1024) {
    const service = new FailRunTaskService();

    await service.call(authenticatedEnv, runId, id, {
      error: {
        message: "Task output is too large. The limit is 3MB",
      },
    });

    return json({ error: "Task output is too large. The limit is 3MB" }, { status: 413 });
  }

  const { "trigger-version": triggerVersion } = headers.data;

  // Now parse the request body
  const anyBody = await parseRequestJsonAsync(request, { runId });

  if (triggerVersion === API_VERSIONS.SERIALIZED_TASK_OUTPUT) {
    const body = await startActiveSpan("CompleteTaskBodyV2InputSchema.safeParse()", async () => {
      return CompleteTaskBodyV2InputSchema.safeParse(anyBody);
    });

    if (!body.success) {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    return await completeRunTask(authenticatedEnv, runId, id, {
      ...body.data,
      output: body.data.output ? (JSON.parse(body.data.output) as any) : undefined,
    });
  } else {
    const body = await startActiveSpan("CompleteTaskBodyInputSchema.safeParse()", async () => {
      return CompleteTaskBodyInputSchema.omit({ output: true }).safeParse(anyBody);
    });

    if (!body.success) {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    const output = (anyBody as any).output;

    return await completeRunTask(authenticatedEnv, runId, id, { ...body.data, output });
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
