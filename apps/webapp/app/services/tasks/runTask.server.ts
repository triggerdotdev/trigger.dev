import { RunTaskBodyOutput, ServerTask } from "@trigger.dev/core";
import { TaskStatus } from "@trigger.dev/database";
import { $transaction, PrismaClient, prisma } from "~/db.server";
import { taskWithAttemptsToServerTask } from "~/models/task.server";
import { ulid } from "~/services/ulid.server";
import { workerQueue } from "~/services/worker.server";

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
        if (existingTask.status === "CANCELED") {
          const existingTaskStatus =
            (taskBody.delayUntil && taskBody.delayUntil.getTime() > Date.now()) || taskBody.trigger
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
          (taskBody.delayUntil && taskBody.delayUntil.getTime() > Date.now()) || taskBody.trigger
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
          parent: taskBody.parentId ? { connect: { id: taskBody.parentId } } : undefined,
          name: taskBody.name ?? "Task",
          description: taskBody.description,
          status,
          startedAt: new Date(),
          completedAt: status === "COMPLETED" || status === "CANCELED" ? new Date() : undefined,
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
