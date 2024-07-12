import { json ,type  ActionFunctionArgs  } from "@remix-run/server-runtime";
import { FailTaskBodyInputSchema } from '@trigger.dev/core/schemas';
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { FailRunTaskService } from "./FailRunTaskService.server";

const ParamsSchema = z.object({
  runId: z.string(),
  id: z.string(),
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

  // Now parse the request body
  const anyBody = await request.json();

  logger.debug("FailRunTaskService.call() request body", {
    body: anyBody,
    runId,
    id,
  });

  const body = FailTaskBodyInputSchema.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new FailRunTaskService();

  try {
    const task = await service.call(authenticatedEnv, runId, id, body.data);

    logger.debug("FailRunTaskService.call() response body", {
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
