import { type RunTaskBodyOutput , type ServerTask } from '@trigger.dev/core/schemas';
import { type TaskStatus } from "@trigger.dev/database";
import { $transaction, type PrismaClient, prisma } from "~/db.server";
import { env } from "~/env.server";
import { taskWithAttemptsToServerTask } from "~/models/task.server";
import { generateSecret } from "~/services/sources/utils.server";
import { ulid } from "~/services/ulid.server";
import { taskOperationWorker, workerQueue } from "~/services/worker.server";
import { startActiveSpan } from "~/v3/tracer.server";

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
    return startActiveSpan("RunTaskService.call", async (span) => {
      span.setAttribute("runId", runId);

      const delayUntilInFuture = taskBody.delayUntil
        ? taskBody.delayUntil.getTime() > Date.now()
        : false;
      const callbackEnabled = taskBody.callback?.enabled ?? false;

      // First
      const existingTask = await this.#handleExistingTask(
        runId,
        idempotencyKey,
        taskBody,
        delayUntilInFuture,
        callbackEnabled
      );

      if (existingTask) {
        span.setAttribute("taskId", existingTask.id);

        return taskWithAttemptsToServerTask(existingTask);
      }

      const run = await this.#prismaClient.jobRun.findUnique({
        where: {
          id: runId,
        },
        select: {
          status: true,
          forceYieldImmediately: true,
        },
      });

      if (!run) throw new Error("Run not found");

      const runConnection = taskBody.connectionKey
        ? await this.#prismaClient.runConnection.findUnique({
            where: {
              runId_key: {
                runId,
                key: taskBody.connectionKey,
              },
            },
            select: {
              id: true,
            },
          })
        : undefined;

      const results = await $transaction(
        this.#prismaClient,
        async (tx) => {
          // If task.delayUntil is set and is in the future, we'll set the task's status to "WAITING", else set it to RUNNING
          let status: TaskStatus;

          if (run.status === "CANCELED") {
            status = "CANCELED";
          } else {
            status =
              delayUntilInFuture || callbackEnabled
                ? "WAITING"
                : taskBody.noop
                ? "COMPLETED"
                : "RUNNING";
          }

          const taskId = ulid();
          const callbackUrl = callbackEnabled
            ? `${env.APP_ORIGIN}/api/v1/tasks/${taskId}/callback/${generateSecret(12)}`
            : undefined;

          const task = await tx.task.create({
            data: {
              id: taskId,
              idempotencyKey,
              displayKey: taskBody.displayKey,
              runConnectionId: runConnection ? runConnection.id : undefined,
              icon: taskBody.icon,
              runId,
              parentId: taskBody.parentId,
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
              childExecutionMode: taskBody.parallel ? "PARALLEL" : "SEQUENTIAL",
            },
          });

          span.setAttribute("taskId", task.id);

          const taskAttempt = await tx.taskAttempt.create({
            data: {
              number: 1,
              taskId: task.id,
              status: "PENDING",
            },
          });

          if (task.status === "RUNNING" && typeof taskBody.operation === "string") {
            // We need to schedule the operation
            await taskOperationWorker.enqueue(
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
                {
                  tx,
                  runAt: new Date(Date.now() + taskBody.callback.timeoutInSeconds * 1000),
                  jobKey: `process-callback:${task.id}`,
                }
              );
            }
          }

          return { task, taskAttempt };
        },
        { timeout: 10000 }
      );

      if (!results) {
        return;
      }

      const { task, taskAttempt } = results;

      return task
        ? taskWithAttemptsToServerTask({ ...task, attempts: [taskAttempt], run })
        : undefined;
    });
  }

  async #handleExistingTask(
    runId: string,
    idempotencyKey: string,
    taskBody: RunTaskBodyOutput,
    delayUntilInFuture: boolean,
    callbackEnabled: boolean
  ) {
    const existingTask = await this.#prismaClient.task.findUnique({
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

    if (existingTask) {
      if (existingTask.status === "CANCELED") {
        const existingTaskStatus =
          delayUntilInFuture || callbackEnabled
            ? "WAITING"
            : taskBody.noop
            ? "COMPLETED"
            : "RUNNING";

        const resumedExistingTask = await this.#prismaClient.task.update({
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
  }

  #filterProperties(properties: RunTaskBodyOutput["properties"]): RunTaskBodyOutput["properties"] {
    if (!properties) return;

    return properties.filter((property) => {
      if (!property) return false;

      return typeof property.label === "string" && typeof property.text === "string";
    });
  }
}
