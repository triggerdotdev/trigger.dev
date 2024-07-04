import { TaskRunExecution } from "@trigger.dev/core/v3";
import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { TaskRun, TaskRunAttempt } from "@trigger.dev/database";
import { machinePresetFromConfig } from "../machinePresets.server";
import { workerQueue } from "~/services/worker.server";
import { MAX_TASK_RUN_ATTEMPTS } from "~/consts";
import { CrashTaskRunService } from "./crashTaskRun.server";

export class CreateTaskRunAttemptService extends BaseService {
  public async call(
    runId: string,
    authenticatedEnv?: AuthenticatedEnvironment,
    setToExecuting = true
  ): Promise<{
    execution: TaskRunExecution;
    run: TaskRun;
    attempt: TaskRunAttempt;
  }> {
    const environment =
      authenticatedEnv ?? (await getAuthenticatedEnvironmentFromRun(runId, this._prisma));

    if (!environment) {
      throw new ServiceValidationError("Environment not found", 404);
    }

    const isFriendlyId = runId.startsWith("run_");

    return await this.traceWithEnv("call()", environment, async (span) => {
      if (isFriendlyId) {
        span.setAttribute("taskRunFriendlyId", runId);
      } else {
        span.setAttribute("taskRunId", runId);
      }

      const taskRun = await this._prisma.taskRun.findUnique({
        where: {
          id: !isFriendlyId ? runId : undefined,
          friendlyId: isFriendlyId ? runId : undefined,
          runtimeEnvironmentId: environment.id,
        },
        include: {
          tags: true,
          attempts: {
            take: 1,
            orderBy: {
              number: "desc",
            },
          },
          lockedBy: {
            include: {
              worker: {
                select: {
                  id: true,
                  version: true,
                  sdkVersion: true,
                  cliVersion: true,
                },
              },
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

      span.setAttribute("taskRunId", taskRun.id);
      span.setAttribute("taskRunFriendlyId", taskRun.friendlyId);

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

      const nextAttemptNumber = taskRun.attempts[0] ? taskRun.attempts[0].number + 1 : 1;

      if (nextAttemptNumber > MAX_TASK_RUN_ATTEMPTS) {
        const service = new CrashTaskRunService(this._prisma);
        await service.call(taskRun.id, {
          reason: taskRun.lockedBy.worker.supportsLazyAttempts
            ? "Max attempts reached."
            : "Max attempts reached. Please upgrade your CLI and SDK.",
        });

        throw new ServiceValidationError("Max attempts reached", 400);
      }

      const taskRunAttempt = await $transaction(this._prisma, async (tx) => {
        const taskRunAttempt = await tx.taskRunAttempt.create({
          data: {
            number: nextAttemptNumber,
            friendlyId: generateFriendlyId("attempt"),
            taskRunId: taskRun.id,
            startedAt: new Date(),
            backgroundWorkerId: taskRun.lockedBy!.worker.id,
            backgroundWorkerTaskId: taskRun.lockedBy!.id,
            status: setToExecuting ? "EXECUTING" : "PENDING",
            queueId: queue.id,
            runtimeEnvironmentId: environment.id,
          },
          include: {
            backgroundWorker: true,
            backgroundWorkerTask: true,
          },
        });

        if (setToExecuting) {
          await tx.taskRun.update({
            where: {
              id: taskRun.id,
            },
            data: {
              status: "EXECUTING",
            },
          });
        }

        return taskRunAttempt;
      });

      if (!taskRunAttempt) {
        logger.error("Failed to create task run attempt", { runId: taskRun.id, nextAttemptNumber });
        throw new ServiceValidationError("Failed to create task run attempt", 500);
      }

      if (taskRunAttempt.number === 1 && taskRun.baseCostInCents > 0) {
        await workerQueue.enqueue("v3.reportUsage", {
          orgId: environment.organizationId,
          data: {
            costInCents: String(taskRun.baseCostInCents),
          },
          additionalData: {
            runId: taskRun.id,
          },
        });
      }

      const machinePreset = machinePresetFromConfig(taskRun.lockedBy.machineConfig ?? {});

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
          startedAt: taskRun.startedAt ?? taskRun.createdAt,
          durationMs: taskRun.usageDurationMs,
          costInCents: taskRun.costInCents,
          baseCostInCents: taskRun.baseCostInCents,
          maxAttempts: taskRun.maxAttempts ?? undefined,
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
        machine: machinePreset,
      };

      return {
        execution,
        run: taskRun,
        attempt: taskRunAttempt,
      };
    });
  }
}

async function getAuthenticatedEnvironmentFromRun(
  friendlyId: string,
  prismaClient?: PrismaClientOrTransaction
) {
  const taskRun = await (prismaClient ?? prisma).taskRun.findUnique({
    where: {
      friendlyId,
    },
    include: {
      runtimeEnvironment: {
        include: {
          organization: true,
          project: true,
        },
      },
    },
  });

  if (!taskRun) {
    return;
  }

  return taskRun?.runtimeEnvironment;
}
