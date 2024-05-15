import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { API_VERSIONS, RunTaskBodyOutputSchema } from "@trigger.dev/core";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { RunTaskService } from "~/services/tasks/runTask.server";
import { ChangeRequestLazyLoadedCachedTasks } from "./ChangeRequestLazyLoadedCachedTasks";

const ParamsSchema = z.object({
  runId: z.string(),
});

const HeadersSchema = z.object({
  "idempotency-key": z.string(),
  "trigger-version": z.string().optional().nullable(),
  "x-cached-tasks-cursor": z.string().optional().nullable(),
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
    return json({ error: "Invalid or Missing idempotency key" }, { status: 400 });
  }

  const {
    "idempotency-key": idempotencyKey,
    "trigger-version": triggerVersion,
    "x-cached-tasks-cursor": cachedTasksCursor,
  } = headers.data;

  const { runId } = ParamsSchema.parse(params);

  // Now parse the request body
  const anyBody = await request.json();

  logger.debug("RunTaskService.call() request body", {
    body: anyBody,
    runId,
    idempotencyKey,
    triggerVersion,
    cachedTasksCursor,
  });

  const body = RunTaskBodyOutputSchema.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new RunTaskService();

  try {
    const task = await service.call(runId, idempotencyKey, body.data);

    logger.debug("RunTaskService.call() response body", {
      runId,
      idempotencyKey,
      task,
    });

    if (!task) {
      return json({ error: "Something went wrong" }, { status: 500 });
    }

    if (triggerVersion === API_VERSIONS.LAZY_LOADED_CACHED_TASKS) {
      const requestMigration = new ChangeRequestLazyLoadedCachedTasks();

      const responseBody = await requestMigration.call(runId, task, cachedTasksCursor);

      logger.debug(
        "RunTaskService.call() response migrating with ChangeRequestLazyLoadedCachedTasks",
        {
          responseBody,
          cachedTasksCursor,
        }
      );

      return json(responseBody, {
        headers: {
          "trigger-version": API_VERSIONS.LAZY_LOADED_CACHED_TASKS,
        },
      });
    }

    return json(task);
  } catch (error) {
    if (error instanceof Error) {
      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
