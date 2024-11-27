import { BatchTriggerTaskRequestBody, logger } from "@trigger.dev/core/v3";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { TriggerTaskService } from "./triggerTask.server";
import { batchTaskRunItemStatusForRunStatus } from "~/models/taskRun.server";
import { isFinalAttemptStatus, isFinalRunStatus } from "../taskStatus";

export type BatchTriggerTaskServiceOptions = {
  idempotencyKey?: string;
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined>;
  spanParentAsLink?: boolean;
};

export class BatchTriggerTaskService extends BaseService {
  public async call(
    taskId: string,
    environment: AuthenticatedEnvironment,
    body: BatchTriggerTaskRequestBody,
    options: BatchTriggerTaskServiceOptions = {}
  ) {
    return await this.traceWithEnv("call()", environment, async (span) => {
      span.setAttribute("taskId", taskId);

      const existingBatch = options.idempotencyKey
        ? await this._prisma.batchTaskRun.findUnique({
            where: {
              runtimeEnvironmentId_idempotencyKey: {
                runtimeEnvironmentId: environment.id,
                idempotencyKey: options.idempotencyKey,
              },
            },
            include: {
              items: {
                include: {
                  taskRun: {
                    select: {
                      friendlyId: true,
                    },
                  },
                },
              },
            },
          })
        : undefined;

      if (existingBatch) {
        span.setAttribute("batchId", existingBatch.friendlyId);
        return {
          batch: existingBatch,
          runs: existingBatch.items.map((item) => item.taskRun.friendlyId),
        };
      }

      const dependentAttempt = body?.dependentAttempt
        ? await this._prisma.taskRunAttempt.findUnique({
            where: { friendlyId: body.dependentAttempt },
            include: {
              taskRun: {
                select: {
                  id: true,
                  status: true,
                },
              },
            },
          })
        : undefined;

      if (
        dependentAttempt &&
        (isFinalAttemptStatus(dependentAttempt.status) ||
          isFinalRunStatus(dependentAttempt.taskRun.status))
      ) {
        logger.debug("Dependent attempt or run is in a terminal state", {
          dependentAttempt: dependentAttempt,
        });

        if (isFinalAttemptStatus(dependentAttempt.status)) {
          throw new ServiceValidationError(
            `Cannot batch trigger ${taskId} as the parent attempt has a status of ${dependentAttempt.status}`
          );
        } else {
          throw new ServiceValidationError(
            `Cannot batch trigger ${taskId} as the parent run has a status of ${dependentAttempt.taskRun.status}`
          );
        }
      }

      const batch = await this._prisma.batchTaskRun.create({
        data: {
          friendlyId: generateFriendlyId("batch"),
          runtimeEnvironmentId: environment.id,
          idempotencyKey: options.idempotencyKey,
          taskIdentifier: taskId,
          dependentTaskAttemptId: dependentAttempt?.id,
        },
      });

      const triggerTaskService = new TriggerTaskService();

      const runs: string[] = [];
      let index = 0;

      for (const item of body.items) {
        try {
          const run = await triggerTaskService.call(
            taskId,
            environment,
            {
              ...item,
              options: {
                ...item.options,
                dependentBatch: dependentAttempt?.id ? batch.friendlyId : undefined, // Only set dependentBatch if dependentAttempt is set which means batchTriggerAndWait was called
                parentBatch: dependentAttempt?.id ? undefined : batch.friendlyId, // Only set parentBatch if dependentAttempt is NOT set which means batchTrigger was called
              },
            },
            {
              triggerVersion: options.triggerVersion,
              traceContext: options.traceContext,
              spanParentAsLink: options.spanParentAsLink,
              batchId: batch.friendlyId,
            }
          );

          if (run) {
            await this._prisma.batchTaskRunItem.create({
              data: {
                batchTaskRunId: batch.id,
                taskRunId: run.id,
                status: batchTaskRunItemStatusForRunStatus(run.status),
              },
            });

            runs.push(run.friendlyId);
          }

          index++;
        } catch (error) {
          logger.error("[BatchTriggerTaskService] Error triggering task", {
            taskId,
            error,
          });
        }
      }

      span.setAttribute("batchId", batch.friendlyId);

      return { batch, runs };
    });
  }
}
