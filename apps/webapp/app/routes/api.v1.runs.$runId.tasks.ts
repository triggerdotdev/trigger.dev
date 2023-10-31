import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { TaskStatus } from "@trigger.dev/database";
import {
  API_VERSIONS,
  RunTaskBodyOutput,
  RunTaskBodyOutputSchema,
  RunTaskResponseWithCachedTasksBody,
  ServerTask,
} from "@trigger.dev/core";
import { z } from "zod";
import { $transaction, PrismaClient, prisma } from "~/db.server";
import { prepareTasksForCaching, taskWithAttemptsToServerTask } from "~/models/task.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { ulid } from "~/services/ulid.server";
import { workerQueue } from "~/services/worker.server";
import { generateSecret } from "~/services/sources/utils.server";
import { env } from "~/env.server";

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

export class RunTaskService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    runId: string,
    idempotencyKey: string,
    taskBody: RunTaskBodyOutput
  ): Promise<ServerTask | undefined> {
    const task = await $transaction(this.#prismaClient, async (tx) => {
      const existingTask = await tx.task.findUnique({
        where: {
          runId_idempotencyKey: {
            runId,
            idempotencyKey,
          },
        },
        include: {
          attempts: true,
          run: true,
        },
      });

      const delayUntilInFuture = taskBody.delayUntil && taskBody.delayUntil.getTime() > Date.now();
      const callbackEnabled = taskBody.callback?.enabled;

      if (existingTask) {
        if (existingTask.status === "CANCELED") {
          const existingTaskStatus =
            delayUntilInFuture || callbackEnabled || taskBody.trigger
              ? "WAITING"
              : taskBody.noop
              ? "COMPLETED"
              : "RUNNING";

          const resumedExistingTask = await tx.task.update({
            where: {
              id: existingTask.id,
            },
            data: {
              status: existingTaskStatus,
              startedAt: new Date(),
              completedAt: existingTaskStatus === "COMPLETED" ? new Date() : undefined,
            },
            include: {
              run: true,
              attempts: true,
            },
          });

          return resumedExistingTask;
        }

        return existingTask;
      }

      const run = await tx.jobRun.findUnique({
        where: {
          id: runId,
        },
        select: {
          status: true,
        },
      });

      if (!run) throw new Error("Run not found");

      // If task.delayUntil is set and is in the future, we'll set the task's status to "WAITING", else set it to RUNNING
      let status: TaskStatus;

      if (run.status === "CANCELED") {
        status = "CANCELED";
      } else {
        status =
          delayUntilInFuture || callbackEnabled || taskBody.trigger
            ? "WAITING"
            : taskBody.noop
            ? "COMPLETED"
            : "RUNNING";
      }

      const taskId = ulid();
      const callbackUrl = callbackEnabled
        ? `${env.APP_ORIGIN}/api/v1/runs/${runId}/tasks/${taskId}/callback/${generateSecret(12)}`
        : undefined;

      const task = await tx.task.create({
        data: {
          id: taskId,
          idempotencyKey,
          displayKey: taskBody.displayKey,
          runConnection: taskBody.connectionKey
            ? {
                connect: {
                  runId_key: {
                    runId,
                    key: taskBody.connectionKey,
                  },
                },
              }
            : undefined,
          icon: taskBody.icon,
          run: {
            connect: {
              id: runId,
            },
          },
          parent: taskBody.parentId ? { connect: { id: taskBody.parentId } } : undefined,
          name: taskBody.name ?? "Task",
          description: taskBody.description,
          status,
          startedAt: new Date(),
          completedAt: status === "COMPLETED" || status === "CANCELED" ? new Date() : undefined,
          noop: taskBody.noop,
          delayUntil: taskBody.delayUntil,
          params: taskBody.params ?? undefined,
          properties: this.#filterProperties(taskBody.properties) ?? undefined,
          redact: taskBody.redact ?? undefined,
          operation: taskBody.operation,
          callbackUrl,
          style: taskBody.style ?? { style: "normal" },
          attempts: {
            create: {
              number: 1,
              status: "PENDING",
            },
          },
        },
        include: {
          run: true,
          attempts: true,
        },
      });

      if (task.status === "RUNNING" && typeof taskBody.operation === "string") {
        // We need to schedule the operation
        await workerQueue.enqueue(
          "performTaskOperation",
          {
            id: task.id,
          },
          { tx, runAt: task.delayUntil ?? undefined, jobKey: `operation:${task.id}` }
        );
      } else if (task.status === "WAITING" && callbackUrl && taskBody.callback) {
        if (taskBody.callback.timeoutInSeconds > 0) {
          // We need to schedule the callback timeout
          await workerQueue.enqueue(
            "processCallbackTimeout",
            {
              id: task.id,
            },
            { tx, runAt: new Date(Date.now() + taskBody.callback.timeoutInSeconds * 1000) }
          );
        }
      }

      return task;
    });

    return task ? taskWithAttemptsToServerTask(task) : undefined;
  }

  #filterProperties(properties: RunTaskBodyOutput["properties"]): RunTaskBodyOutput["properties"] {
    if (!properties) return;

    return properties.filter((property) => {
      if (!property) return false;

      return typeof property.label === "string" && typeof property.text === "string";
    });
  }
}
