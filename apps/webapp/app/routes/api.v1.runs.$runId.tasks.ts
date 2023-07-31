import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { TaskStatus } from "@trigger.dev/database";
import {
  RunTaskBodyOutput,
  RunTaskBodyOutputSchema,
  ServerTask,
} from "@trigger.dev/core";
import { z } from "zod";
import { $transaction, PrismaClient, prisma } from "~/db.server";
import { taskWithAttemptsToServerTask } from "~/models/task.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { ulid } from "~/services/ulid.server";
import { workerQueue } from "~/services/worker.server";

const ParamsSchema = z.object({
  runId: z.string(),
});

const HeadersSchema = z.object({
  "idempotency-key": z.string(),
});

export async function action({ request, params }: ActionArgs) {
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

    if (!task) {
      return json({ error: "Something went wrong" }, { status: 500 });
    }

    return json(task);
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
        },
      });

      if (existingTask) {
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
          (taskBody.delayUntil && taskBody.delayUntil.getTime() > Date.now()) ||
          taskBody.trigger
            ? "WAITING"
            : taskBody.noop
            ? "COMPLETED"
            : "RUNNING";
      }

      const task = await tx.task.create({
        data: {
          id: ulid(),
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
          parent: taskBody.parentId
            ? { connect: { id: taskBody.parentId } }
            : undefined,
          name: taskBody.name,
          description: taskBody.description,
          status,
          startedAt: new Date(),
          completedAt:
            status === "COMPLETED" || status === "CANCELED"
              ? new Date()
              : undefined,
          noop: taskBody.noop,
          delayUntil: taskBody.delayUntil,
          params: taskBody.params ?? undefined,
          properties: taskBody.properties ?? undefined,
          redact: taskBody.redact ?? undefined,
          operation: taskBody.operation,
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
          { tx, runAt: task.delayUntil ?? undefined }
        );
      }

      return task;
    });

    return task ? taskWithAttemptsToServerTask(task) : undefined;
  }
}
