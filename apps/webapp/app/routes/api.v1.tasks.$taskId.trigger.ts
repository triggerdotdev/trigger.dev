import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import {
  API_VERSIONS,
  RunTaskBodyOutputSchema,
  RunTaskResponseWithCachedTasksBody,
  ServerTask,
  parseTriggerTaskRequestBody,
} from "@trigger.dev/core";
import { z } from "zod";
import { PrismaClient, prisma } from "~/db.server";
import { prepareTasksForCaching } from "~/models/task.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { RunTaskService } from "~/services/tasks/runTask.server";
import { generateRunId } from "~/v3/idGenerator.server";
import { TriggerTaskService } from "~/v3/services/triggerTask.server";

const ParamsSchema = z.object({
  taskId: z.string(),
});

const HeadersSchema = z.object({
  "idempotency-key": z.string().optional().nullable(),
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

  const headers = HeadersSchema.safeParse(Object.fromEntries(request.headers));

  if (!headers.success) {
    return json({ error: "Invalid headers" }, { status: 400 });
  }

  const { "idempotency-key": idempotencyKey, "trigger-version": triggerVersion } = headers.data;

  const { taskId } = ParamsSchema.parse(params);

  // Now parse the request body
  const anyBody = await request.json();

  const body = parseTriggerTaskRequestBody(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new TriggerTaskService();

  const runId = generateRunId();

  try {
    await service.call(runId, taskId, authenticationResult.environment, body.data, {
      idempotencyKey: idempotencyKey ?? undefined,
      triggerVersion: triggerVersion ?? undefined,
    });

    return json({
      id: runId,
    });
  } catch (error) {
    if (error instanceof Error) {
      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
