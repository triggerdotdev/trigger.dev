import {
  PRIMARY_VARIANT,
  SemanticInternalAttributes,
  TriggerTaskRequestBody,
} from "@trigger.dev/core/v3";
import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import { $transaction } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { eventRepository } from "../eventRepository.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { marqs } from "../marqs.server";
import { BaseService } from "./baseService.server";

export type TriggerTaskServiceOptions = {
  idempotencyKey?: string;
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined>;
};

export class TriggerTaskService extends BaseService {
  public async call(
    taskId: string,
    environment: AuthenticatedEnvironment,
    body: TriggerTaskRequestBody,
    options: TriggerTaskServiceOptions = {}
  ) {
    return await this.traceWithEnv("call()", environment, async (span) => {
      span.setAttribute("taskId", taskId);

      const idempotencyKey = options.idempotencyKey ?? nanoid();

      const existingRun = await this._prisma.taskRun.findUnique({
        where: {
          runtimeEnvironmentId_idempotencyKey: {
            runtimeEnvironmentId: environment.id,
            idempotencyKey,
          },
        },
      });

      if (existingRun) {
        span.setAttribute("runId", existingRun.friendlyId);
        return existingRun;
      }

      return await eventRepository.traceEvent(
        taskId,
        {
          context: options.traceContext,
          kind: "SERVER",
          environment,
          taskSlug: taskId,
          attributes: {
            properties: {
              [SemanticInternalAttributes.PAYLOAD]: body.payload,
            },
            style: {
              icon: "play",
              variant: PRIMARY_VARIANT,
            },
            runIsTest: body.options?.test ?? false,
          },
          incomplete: true,
          immediate: true,
        },
        async (event, traceContext) => {
          const lockId = taskIdentifierToLockId(taskId);

          return await $transaction(this._prisma, async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;

            const lockedToBackgroundWorker = body.options?.lockToVersion
              ? await tx.backgroundWorker.findUnique({
                  where: {
                    projectId_runtimeEnvironmentId_version: {
                      projectId: environment.projectId,
                      runtimeEnvironmentId: environment.id,
                      version: body.options?.lockToVersion,
                    },
                  },
                })
              : undefined;

            const counter = await tx.taskRunCounter.upsert({
              where: { taskIdentifier: taskId },
              update: { lastNumber: { increment: 1 } },
              create: { taskIdentifier: taskId, lastNumber: 1 },
              select: { lastNumber: true },
            });

            const queueName = body.options?.queue?.name ?? `task/${taskId}`;

            event.setAttribute("queueName", queueName);
            span.setAttribute("queueName", queueName);

            const taskRun = await tx.taskRun.create({
              data: {
                number: counter.lastNumber,
                friendlyId: generateFriendlyId("run"),
                runtimeEnvironmentId: environment.id,
                projectId: environment.projectId,
                idempotencyKey,
                taskIdentifier: taskId,
                payload: JSON.stringify(body.payload),
                payloadType: "application/json",
                context: body.context,
                traceContext: traceContext,
                traceId: event.traceId,
                spanId: event.spanId,
                lockedToVersionId: lockedToBackgroundWorker?.id,
                concurrencyKey: body.options?.concurrencyKey,
                queue: queueName,
                isTest: body.options?.test ?? false,
              },
            });

            event.setAttribute("runId", taskRun.friendlyId);
            span.setAttribute("runId", taskRun.friendlyId);

            if (body.options?.dependentAttempt) {
              const dependentAttempt = await tx.taskRun.findUnique({
                where: { friendlyId: body.options.dependentAttempt },
              });

              if (dependentAttempt) {
                await tx.taskRunDependency.create({
                  data: {
                    taskRunId: taskRun.id,
                    dependentAttemptId: dependentAttempt.id,
                  },
                });
              }
            } else if (body.options?.dependentBatch) {
              const dependentBatchRun = await tx.batchTaskRun.findUnique({
                where: { friendlyId: body.options.dependentBatch },
              });

              if (dependentBatchRun) {
                await tx.taskRunDependency.create({
                  data: {
                    taskRunId: taskRun.id,
                    dependentBatchRunId: dependentBatchRun.id,
                  },
                });
              }
            }

            // We need to enqueue the task run into the appropriate queue
            await marqs?.enqueueMessage(
              environment,
              queueName,
              taskRun.id,
              { type: "EXECUTE", taskIdentifier: taskId },
              body.options?.concurrencyKey
            );

            return taskRun;
          });
        }
      );
    });
  }
}

function taskIdentifierToLockId(taskIdentifier: string): number {
  // Convert taskIdentifier to a unique lock identifier
  return parseInt(createHash("sha256").update(taskIdentifier).digest("hex").slice(0, 8), 16);
}
