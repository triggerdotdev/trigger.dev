import { BatchTriggerTaskRequestBody } from "@trigger.dev/core/v3";
import { nanoid } from "nanoid";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { BaseService } from "./baseService.server";
import { TriggerTaskService } from "./triggerTask.server";
import { BatchTaskRunItem } from "@trigger.dev/database";

export type BatchTriggerTaskServiceOptions = {
  idempotencyKey?: string;
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined>;
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

      const idempotencyKey = options.idempotencyKey ?? nanoid();

      const existingBatch = await this._prisma.batchTaskRun.findUnique({
        where: {
          runtimeEnvironmentId_idempotencyKey: {
            runtimeEnvironmentId: environment.id,
            idempotencyKey,
          },
        },
        include: {
          items: {
            include: {
              taskRun: true,
            },
          },
        },
      });

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
          idempotencyKey,
          taskIdentifier: taskId,
          dependentTaskAttemptId: dependentAttempt?.id,
        },
      });

      const triggerTaskService = new TriggerTaskService();

      const runs: string[] = [];

      for (const item of body.items) {
        const idempotencyKey = nanoid();

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
            idempotencyKey,
            triggerVersion: options.triggerVersion,
            traceContext: options.traceContext,
          }
        );

        if (run) {
          await this._prisma.batchTaskRunItem.create({
            data: {
              batchTaskRunId: batch.id,
              taskRunId: run.id,
            },
          });

          runs.push(run.friendlyId);
        }
      }

      span.setAttribute("batchId", batch.friendlyId);

      return { batch, runs };
    });
  }
}
