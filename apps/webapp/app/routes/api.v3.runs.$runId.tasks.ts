import type { ActionArgs, LoaderArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { RunTaskBodyOutput, ServerTaskSchema } from "@trigger.dev/internal";
import { RunTaskBodyOutputSchema } from "@trigger.dev/internal";
import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger";
import { ulid } from "~/services/ulid.server";

const ParamsSchema = z.object({
  runId: z.string(),
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

  const { runId } = ParamsSchema.parse(params);

  const url = new URL(request.url);
  const query = SearchQuerySchema.parse(Object.fromEntries(url.searchParams));

  const jobRun = await prisma.jobRun.findUnique({
    where: {
      id: runId,
    },
    include: {
      tasks: {
        where: {
          parentId: null,
        },
        include: {
          children: {
            include: {
              children: {
                include: {
                  children: {
                    include: {
                      children: {
                        include: {
                          children: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
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

  if (!jobRun) {
    return json({ message: "Run not found" }, { status: 404 });
  }

  if (jobRun.environmentId !== authenticatedEnv.id) {
    return json({ message: "Run not found" }, { status: 404 });
  }

  const tasks = jobRun.tasks.slice(0, query.take);
  const nextTask = jobRun.tasks[query.take];

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

  const { runId } = ParamsSchema.parse(params);

  // Now parse the request body
  const anyBody = await request.json();

  logger.debug("RunTaskService.call() request body", {
    body: anyBody,
    runId,
    idempotencyKey,
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

    return json(ServerTaskSchema.parse(task));
  } catch (error) {
    if (error instanceof Error) {
      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
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
  ) {
    // Using a transaction, we'll first check to see if the task already exists and return if if it does
    // If it doesn't exist, we'll create it and return it
    const task = await this.#prismaClient.$transaction(async (prisma) => {
      const existingTask = await prisma.task.findUnique({
        where: {
          runId_idempotencyKey: {
            runId,
            idempotencyKey,
          },
        },
      });

      if (existingTask) {
        return existingTask;
      }

      // If task.delayUntil is set and is in the future, we'll set the task's status to "WAITING", else set it to RUNNING
      const status =
        (taskBody.delayUntil && taskBody.delayUntil.getTime() > Date.now()) ||
        taskBody.trigger
          ? "WAITING"
          : taskBody.noop
          ? "COMPLETED"
          : "RUNNING";

      const task = await prisma.task.create({
        data: {
          id: ulid(),
          idempotencyKey,
          displayKey: taskBody.displayKey,
          icon: taskBody.icon,
          run: {
            connect: {
              id: runId,
            },
          },
          parent: taskBody.parentId
            ? { connect: { id: taskBody.parentId } }
            : undefined,
          name: taskBody.name,
          description: taskBody.description,
          status,
          startedAt: new Date(),
          completedAt: status === "COMPLETED" ? new Date() : undefined,
          noop: taskBody.noop,
          delayUntil: taskBody.delayUntil,
          params: taskBody.params ?? undefined,
          elements: taskBody.elements ?? undefined,
          redact: taskBody.redact ?? undefined,
        },
        include: {
          run: true,
        },
      });

      // TODO: do this client side instead of adding an option to taskBody
      // if (taskBody.trigger) {
      //   // Create an eventrule for the task
      //   await prisma.jobEventRule.upsert({
      //     where: {
      //       jobInstanceId_actionIdentifier: {
      //         jobInstanceId: task.run.jobInstanceId,
      //         actionIdentifier: task.id,
      //       },
      //     },
      //     create: {
      //       action: "RESUME_TASK",
      //       actionIdentifier: task.id,
      //       jobId: task.run.jobId,
      //       jobInstanceId: task.run.jobInstanceId,
      //       environmentId: task.run.environmentId,
      //       organizationId: task.run.organizationId,
      //       projectId: task.run.projectId,
      //       event: taskBody.trigger.eventRule.event,
      //       source: taskBody.trigger.eventRule.source,
      //       payloadFilter: taskBody.trigger.eventRule.payload ?? {},
      //       contextFilter: taskBody.trigger.eventRule.context ?? {},
      //       enabled: true,
      //     },
      //     update: {
      //       event: taskBody.trigger.eventRule.event,
      //       source: taskBody.trigger.eventRule.source,
      //       payloadFilter: taskBody.trigger.eventRule.payload ?? {},
      //       contextFilter: taskBody.trigger.eventRule.context ?? {},
      //     },
      //   });
      // }

      return task;
    });

    return task;
  }
}
