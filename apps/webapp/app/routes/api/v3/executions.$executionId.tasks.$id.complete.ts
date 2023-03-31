import { RuntimeEnvironment } from ".prisma/client";
import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import {
  CompleteTaskBodyInput,
  CompleteTaskBodyInputSchema,
  CompleteTaskBodyOutput,
  RunTaskBodyOutput,
} from "@trigger.dev/internal";
import { RunTaskBodyOutputSchema } from "@trigger.dev/internal";
import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger";

const ParamsSchema = z.object({
  executionId: z.string(),
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

  const { executionId, id } = ParamsSchema.parse(params);

  // Now parse the request body
  const anyBody = await request.json();

  logger.debug("CompleteExecutionTaskService.call() request body", {
    body: anyBody,
    executionId,
    id,
  });

  const body = CompleteTaskBodyInputSchema.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new CompleteExecutionTaskService();

  try {
    const task = await service.call(
      authenticatedEnv,
      executionId,
      id,
      body.data
    );

    logger.debug("CompleteExecutionTaskService.call() response body", {
      executionId,
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

export class CompleteExecutionTaskService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    environment: RuntimeEnvironment,
    executionId: string,
    id: string,
    taskBody: CompleteTaskBodyOutput
  ) {
    // Using a transaction, we'll first check to see if the task already exists and return if if it does
    // If it doesn't exist, we'll create it and return it
    const task = await this.#prismaClient.$transaction(async (prisma) => {
      const existingTask = await prisma.task.findUnique({
        where: {
          id,
        },
        include: {
          execution: true,
        },
      });

      if (!existingTask) {
        return;
      }

      if (existingTask.executionId !== executionId) {
        return;
      }

      if (existingTask.execution.environmentId !== environment.id) {
        return;
      }

      if (
        existingTask.status === "COMPLETED" ||
        existingTask.status === "ERRORED"
      ) {
        return existingTask;
      }

      const task = await prisma.task.update({
        where: {
          id,
        },
        data: {
          status: "COMPLETED",
          output: taskBody.output ?? undefined,
          completedAt: new Date(),
        },
      });

      return task;
    });

    return task;
  }
}
