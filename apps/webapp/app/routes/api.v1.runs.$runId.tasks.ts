import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import {
  API_VERSIONS,
  RunTaskBodyOutputSchema,
  RunTaskResponseWithCachedTasksBody,
  ServerTask,
} from "@trigger.dev/core";
import { z } from "zod";
import { PrismaClient, prisma } from "~/db.server";
import { prepareTasksForCaching } from "~/models/task.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { RunTaskService } from "~/services/tasks/runTask.server";

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

class ChangeRequestLazyLoadedCachedTasks {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    runId: string,
    task: ServerTask,
    cursor?: string | null
  ): Promise<RunTaskResponseWithCachedTasksBody> {
    if (!cursor) {
      return {
        task,
      };
    }

    // We need to limit the cached tasks to not be too large >2MB when serialized
    const TOTAL_CACHED_TASK_BYTE_LIMIT = 2000000;

    const nextTasks = await this.#prismaClient.task.findMany({
      where: {
        runId,
        status: "COMPLETED",
        noop: false,
      },
      take: 250,
      cursor: {
        id: cursor,
      },
      orderBy: {
        id: "asc",
      },
    });

    const preparedTasks = prepareTasksForCaching(nextTasks, TOTAL_CACHED_TASK_BYTE_LIMIT);

    return {
      task,
      cachedTasks: preparedTasks,
    };
  }
}
