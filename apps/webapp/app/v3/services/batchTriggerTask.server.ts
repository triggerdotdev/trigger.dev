import { BatchTriggerTaskRequestBody } from "@trigger.dev/core/v3";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { BaseService } from "./baseService.server";
import { TriggerTaskService } from "./triggerTask.server";
import { batchTaskRunItemStatusForRunStatus } from "~/models/taskRun.server";

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
                  taskRun: true,
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
          })
        : undefined;

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
        const run = await triggerTaskService.call(
          taskId,
          environment,
          {
            ...item,
            options: {
              ...item.options,
              dependentBatch: dependentAttempt?.id ? batch.friendlyId : undefined, // Only set dependentBatch if dependentAttempt is set which means batchTriggerAndWait was called
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
      }

      span.setAttribute("batchId", batch.friendlyId);

      return { batch, runs };
    });
  }
}
