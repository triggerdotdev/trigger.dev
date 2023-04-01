import type { ActionArgs, LoaderArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { RunTaskBodyOutput } from "@trigger.dev/internal";
import { RunTaskBodyOutputSchema } from "@trigger.dev/internal";
import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger";
import { ulid } from "~/services/ulid.server";

const ParamsSchema = z.object({
  executionId: z.string(),
});

const HeadersSchema = z.object({
  "idempotency-key": z.string(),
});

const SearchQuerySchema = z.object({
  cursor: z.string().optional(),
  take: z.coerce.number().default(50),
});

export async function loader({ request, params }: LoaderArgs) {
  // Next authenticate the request
  const authenticatedEnv = await authenticateApiRequest(request);

  if (!authenticatedEnv) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const { executionId } = ParamsSchema.parse(params);

  const url = new URL(request.url);
  const query = SearchQuerySchema.parse(Object.fromEntries(url.searchParams));

  const execution = await prisma.execution.findUnique({
    where: {
      id: executionId,
    },
    include: {
      tasks: {
        orderBy: {
          id: "asc",
        },
        take: query.take + 1,
        cursor: query.cursor
          ? {
              id: query.cursor,
            }
          : undefined,
      },
    },
  });

  if (!execution) {
    return json({ error: "Execution not found" }, { status: 404 });
  }

  if (execution.environmentId !== authenticatedEnv.id) {
    return json({ error: "Execution not found" }, { status: 404 });
  }

  const tasks = execution.tasks.slice(0, query.take);
  const nextTask = execution.tasks[query.take];

  return json({
    data: tasks,
    nextCursor: nextTask ? nextTask.id : undefined,
  });
}

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

  const headers = HeadersSchema.safeParse(Object.fromEntries(request.headers));

  if (!headers.success) {
    return json(
      { error: "Invalid or Missing idempotency key" },
      { status: 400 }
    );
  }

  const { "idempotency-key": idempotencyKey } = headers.data;

  const { executionId } = ParamsSchema.parse(params);

  // Now parse the request body
  const anyBody = await request.json();

  logger.debug("RunExecutionTaskService.call() request body", {
    body: anyBody,
    executionId,
    idempotencyKey,
  });

  const body = RunTaskBodyOutputSchema.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new RunExecutionTaskService();

  try {
    const task = await service.call(executionId, idempotencyKey, body.data);

    logger.debug("RunExecutionTaskService.call() response body", {
      executionId,
      idempotencyKey,
      task,
    });

    return json(task);
  } catch (error) {
    if (error instanceof Error) {
      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}

export class RunExecutionTaskService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    executionId: string,
    idempotencyKey: string,
    taskBody: RunTaskBodyOutput
  ) {
    // Using a transaction, we'll first check to see if the task already exists and return if if it does
    // If it doesn't exist, we'll create it and return it
    const task = await this.#prismaClient.$transaction(async (prisma) => {
      const existingTask = await prisma.task.findUnique({
        where: {
          executionId_idempotencyKey: {
            executionId,
            idempotencyKey,
          },
        },
      });

      if (existingTask) {
        return existingTask;
      }

      // If task.delayUntil is set and is in the future, we'll set the task's status to "WAITING", else set it to RUNNING
      const status =
        taskBody.delayUntil && taskBody.delayUntil.getTime() > Date.now()
          ? "WAITING"
          : taskBody.noop
          ? "COMPLETED"
          : "RUNNING";

      const task = await prisma.task.create({
        data: {
          id: ulid(),
          idempotencyKey,
          execution: {
            connect: {
              id: executionId,
            },
          },
          name: taskBody.name,
          description: taskBody.description,
          status,
          startedAt: new Date(),
          completedAt: status === "COMPLETED" ? new Date() : undefined,
          noop: taskBody.noop,
          delayUntil: taskBody.delayUntil,
          params: taskBody.params ?? undefined,
          displayProperties: taskBody.displayProperties ?? undefined,
        },
      });

      return task;
    });

    return task;
  }
}
