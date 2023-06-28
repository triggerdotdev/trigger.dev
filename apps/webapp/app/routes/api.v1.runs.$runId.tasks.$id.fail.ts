import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import {
  FailTaskBodyInput,
  FailTaskBodyInputSchema,
  ServerTask,
} from "@trigger.dev/internal";
import { z } from "zod";
import { $transaction, PrismaClient, prisma } from "~/db.server";
import { taskWithAttemptsToServerTask } from "~/models/task.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { formatError } from "~/utils/formatErrors.server";

const ParamsSchema = z.object({
  runId: z.string(),
  id: z.string(),
});

export async function action({ request, params }: ActionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Next authenticate the request
  const authenticatedEnv = await authenticateApiRequest(request);

  if (!authenticatedEnv) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

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

export class FailRunTaskService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    environment: AuthenticatedEnvironment,
    runId: string,
    id: string,
    taskBody: FailTaskBodyInput
  ): Promise<ServerTask | undefined> {
    // Using a transaction, we'll first check to see if the task already exists and return if if it does
    // If it doesn't exist, we'll create it and return it
    const task = await this.#prismaClient.$transaction(async (prisma) => {
      const existingTask = await prisma.task.findUnique({
        where: {
          id,
        },
        include: {
          run: true,
          attempts: {
            where: {
              status: "PENDING",
            },
            orderBy: {
              number: "desc",
            },
            take: 1,
          },
        },
      });

      if (!existingTask) {
        return;
      }

      if (existingTask.runId !== runId) {
        return;
      }

      if (existingTask.run.environmentId !== environment.id) {
        return;
      }

      if (
        existingTask.status === "COMPLETED" ||
        existingTask.status === "ERRORED"
      ) {
        logger.debug("Task already completed", {
          existingTask,
        });

        return existingTask;
      }

      const task = await $transaction(prisma, async (tx) => {
        if (existingTask.attempts.length === 1) {
          await tx.taskAttempt.update({
            where: {
              id: existingTask.attempts[0].id,
            },
            data: {
              status: "ERRORED",
              error: formatError(taskBody.error),
            },
          });
        }

        return await prisma.task.update({
          where: {
            id,
          },
          data: {
            status: "ERRORED",
            output: taskBody.error ?? undefined,
            completedAt: new Date(),
          },
          include: {
            attempts: true,
          },
        });
      });

      return task;
    });

    return task ? taskWithAttemptsToServerTask(task) : undefined;
  }
}
