import { parsePacket, V3TaskRunExecution } from "@trigger.dev/core/v3";
import { TaskRun, TaskRunAttempt } from "@trigger.dev/database";
import { MAX_TASK_RUN_ATTEMPTS } from "~/consts";
import { $transaction, prisma, PrismaClientOrTransaction } from "~/db.server";
import { findQueueInEnvironment } from "~/models/taskQueue.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { reportInvocationUsage } from "~/services/platform.v3.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { machinePresetFromConfig, machinePresetFromRun } from "../machinePresets.server";
import { FINAL_RUN_STATUSES } from "../taskStatus";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { CrashTaskRunService } from "./crashTaskRun.server";
import { ExpireEnqueuedRunService } from "./expireEnqueuedRun.server";

export class CreateTaskRunAttemptService extends BaseService {
  public async call({
    runId,
    authenticatedEnv,
    setToExecuting = true,
    startAtZero = false,
  }: {
    runId: string;
    authenticatedEnv?: AuthenticatedEnvironment;
    setToExecuting?: boolean;
    startAtZero?: boolean;
  }): Promise<{
    execution: V3TaskRunExecution;
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

      const taskRun = await this._prisma.taskRun.findFirst({
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
                  supportsLazyAttempts: true,
                },
              },
            },
          },
          batchItems: {
            include: {
              batchTaskRun: {
                select: {
                  friendlyId: true,
                },
              },
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
      span.setAttribute("taskRunStatus", taskRun.status);

      if (taskRun.status === "CANCELED") {
        throw new ServiceValidationError("Task run is cancelled", 400);
      }

      // If the run is finalized, it's pointless to create another attempt
      if (FINAL_RUN_STATUSES.includes(taskRun.status)) {
        throw new ServiceValidationError("Task run is already finished", 400);
      }

      const lockedBy = taskRun.lockedBy;

      if (!lockedBy) {
        throw new ServiceValidationError("Task run is not locked", 400);
      }

      const queue = await findQueueInEnvironment(
        taskRun.queue,
        environment.id,
        lockedBy.id,
        lockedBy
      );

      if (!queue) {
        throw new ServiceValidationError("Queue not found", 404);
      }

      const nextAttemptNumber = taskRun.attempts[0]
        ? taskRun.attempts[0].number + 1
        : startAtZero
        ? 0
        : 1;

      if (nextAttemptNumber > MAX_TASK_RUN_ATTEMPTS) {
        const service = new CrashTaskRunService(this._prisma);
        await service.call(taskRun.id, {
          reason: lockedBy.worker.supportsLazyAttempts
            ? "Max attempts reached."
            : "Max attempts reached. Please upgrade your CLI and SDK.",
        });

        throw new ServiceValidationError("Max attempts reached", 400);
      }

      const taskRunAttempt = await $transaction(this._prisma, "create attempt", async (tx) => {
        const taskRunAttempt = await tx.taskRunAttempt.create({
          data: {
            number: nextAttemptNumber,
            friendlyId: generateFriendlyId("attempt"),
            taskRunId: taskRun.id,
            startedAt: new Date(),
            backgroundWorkerId: lockedBy.worker.id,
            backgroundWorkerTaskId: lockedBy.id,
            status: setToExecuting ? "EXECUTING" : "PENDING",
            queueId: queue.id,
            runtimeEnvironmentId: environment.id,
          },
        });

        await tx.taskRun.update({
          where: {
            id: taskRun.id,
          },
          data: {
            status: setToExecuting ? "EXECUTING" : undefined,
            executedAt: taskRun.executedAt ?? new Date(),
            attemptNumber: nextAttemptNumber,
          },
        });

        if (taskRun.ttl) {
          await ExpireEnqueuedRunService.ack(taskRun.id, tx);
        }

        return taskRunAttempt;
      });

      if (!taskRunAttempt) {
        logger.error("Failed to create task run attempt", { runId: taskRun.id, nextAttemptNumber });
        throw new ServiceValidationError("Failed to create task run attempt", 500);
      }

      if (taskRunAttempt.number === 1 && taskRun.baseCostInCents > 0) {
        await reportInvocationUsage(environment.organizationId, taskRun.baseCostInCents, {
          runId: taskRun.id,
        });
      }

      const machinePreset =
        machinePresetFromRun(taskRun) ?? machinePresetFromConfig(lockedBy.machineConfig ?? {});

      const metadata = await parsePacket({
        data: taskRun.metadata ?? undefined,
        dataType: taskRun.metadataType,
      });

      const execution: V3TaskRunExecution = {
        task: {
          id: lockedBy.slug,
          filePath: lockedBy.filePath,
          exportName: lockedBy.exportName ?? "@deprecated",
        },
        attempt: {
          id: taskRunAttempt.friendlyId,
          number: taskRunAttempt.number,
          startedAt: taskRunAttempt.startedAt ?? taskRunAttempt.createdAt,
          backgroundWorkerId: lockedBy.worker.id,
          backgroundWorkerTaskId: lockedBy.id,
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
          concurrencyKey: taskRun.concurrencyKey ?? undefined,
          startedAt: taskRun.startedAt ?? taskRun.createdAt,
          durationMs: taskRun.usageDurationMs,
          costInCents: taskRun.costInCents,
          baseCostInCents: taskRun.baseCostInCents,
          maxAttempts: taskRun.maxAttempts ?? undefined,
          version: lockedBy.worker.version,
          metadata,
          maxDuration: taskRun.maxDurationInSeconds ?? undefined,
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
  const isFriendlyId = friendlyId.startsWith("run_");

  const taskRun = await (prismaClient ?? prisma).taskRun.findFirst({
    where: {
      id: !isFriendlyId ? friendlyId : undefined,
      friendlyId: isFriendlyId ? friendlyId : undefined,
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
