import { TaskRunExecution } from "@trigger.dev/core/v3";
import { $transaction } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { BaseService, ServiceValidationError } from "./baseService.server";

export class CreateTaskRunAttemptService extends BaseService {
  public async call(
    runFriendlyId: string,
    environment: AuthenticatedEnvironment
  ): Promise<TaskRunExecution> {
    return await this.traceWithEnv("call()", environment, async (span) => {
      span.setAttribute("taskRunId", runFriendlyId);

      const taskRun = await this._prisma.taskRun.findUnique({
        where: {
          friendlyId: runFriendlyId,
          runtimeEnvironmentId: environment.id,
        },
        include: {
          tags: true,
          attempts: true,
          lockedBy: {
            include: {
              worker: true,
            },
          },
          batchItems: {
            include: {
              batchTaskRun: true,
            },
          },
        },
      });

      logger.debug("Creating a task run attempt", { taskRun });

      if (!taskRun) {
        throw new ServiceValidationError("Task run not found", 404);
      }

      if (taskRun.status === "CANCELED") {
        throw new ServiceValidationError("Task run is cancelled", 400);
      }

      if (!taskRun.lockedBy) {
        throw new ServiceValidationError("Task run is not locked", 400);
      }

      const queue = await this._prisma.taskQueue.findUnique({
        where: {
          runtimeEnvironmentId_name: {
            runtimeEnvironmentId: environment.id,
            name: taskRun.queue,
          },
        },
      });

      if (!queue) {
        throw new ServiceValidationError("Queue not found", 404);
      }

      const taskRunAttempt = await $transaction(this._prisma, async (tx) => {
        const taskRunAttempt = await tx.taskRunAttempt.create({
          data: {
            number: taskRun.attempts[0] ? taskRun.attempts[0].number + 1 : 1,
            friendlyId: generateFriendlyId("attempt"),
            taskRunId: taskRun.id,
            startedAt: new Date(),
            backgroundWorkerId: taskRun.lockedBy!.worker.id,
            backgroundWorkerTaskId: taskRun.lockedBy!.id,
            status: "EXECUTING" as const,
            queueId: queue.id,
            runtimeEnvironmentId: environment.id,
          },
        });

        await tx.taskRun.update({
          where: {
            id: taskRun.id,
          },
          data: {
            status: "EXECUTING",
          },
        });

        return taskRunAttempt;
      });

      if (!taskRunAttempt) {
        throw new ServiceValidationError("Failed to create task run attempt", 500);
      }

      const execution: TaskRunExecution = {
        task: {
          id: taskRun.lockedBy.slug,
          filePath: taskRun.lockedBy.filePath,
          exportName: taskRun.lockedBy.exportName,
        },
        attempt: {
          id: taskRunAttempt.friendlyId,
          number: taskRunAttempt.number,
          startedAt: taskRunAttempt.startedAt ?? taskRunAttempt.createdAt,
          backgroundWorkerId: taskRun.lockedBy.worker.id,
          backgroundWorkerTaskId: taskRun.lockedBy.id,
          status: "EXECUTING" as const,
        },
        run: {
          id: taskRun.friendlyId,
          payload: taskRun.payload,
          payloadType: taskRun.payloadType,
          context: taskRun.context,
          createdAt: taskRun.createdAt,
          tags: taskRun.tags.map((tag) => tag.name),
          isTest: taskRun.isTest,
          idempotencyKey: taskRun.idempotencyKey ?? undefined,
        },
        queue: {
          id: queue.friendlyId,
          name: queue.name,
        },
        environment: {
          id: environment.id,
          slug: environment.slug,
          type: environment.type,
        },
        organization: {
          id: environment.organization.id,
          slug: environment.organization.slug,
          name: environment.organization.title,
        },
        project: {
          id: environment.project.id,
          ref: environment.project.externalRef,
          slug: environment.project.slug,
          name: environment.project.name,
        },
        batch:
          taskRun.batchItems[0] && taskRun.batchItems[0].batchTaskRun
            ? { id: taskRun.batchItems[0].batchTaskRun.friendlyId }
            : undefined,
      };

      return execution;
    });
  }
}
