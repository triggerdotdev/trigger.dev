import {
  IOPacket,
  SemanticInternalAttributes,
  TriggerTaskRequestBody,
  packetRequiresOffloading,
} from "@trigger.dev/core/v3";
import { prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { autoIncrementCounter } from "~/services/autoIncrementCounter.server";
import { marqs, sanitizeQueueName } from "~/v3/marqs/index.server";
import { eventRepository } from "../eventRepository.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { uploadToObjectStore } from "../r2.server";
import { BaseService } from "./baseService.server";
import { getEntitlement } from "~/services/platform.v3.server";

export type TriggerTaskServiceOptions = {
  idempotencyKey?: string;
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined>;
  spanParentAsLink?: boolean;
  parentAsLinkType?: "replay" | "trigger";
  batchId?: string;
  customIcon?: string;
};

export class OutOfEntitlementError extends Error {
  constructor() {
    super("You can't trigger a task because you have run out of credits.");
  }
}

export class TriggerTaskService extends BaseService {
  public async call(
    taskId: string,
    environment: AuthenticatedEnvironment,
    body: TriggerTaskRequestBody,
    options: TriggerTaskServiceOptions = {}
  ) {
    return await this.traceWithEnv("call()", environment, async (span) => {
      span.setAttribute("taskId", taskId);

      const idempotencyKey = options.idempotencyKey ?? body.options?.idempotencyKey;

      const existingRun = idempotencyKey
        ? await this._prisma.taskRun.findUnique({
            where: {
              runtimeEnvironmentId_idempotencyKey: {
                runtimeEnvironmentId: environment.id,
                idempotencyKey,
              },
            },
          })
        : undefined;

      if (existingRun && existingRun.taskIdentifier === taskId) {
        span.setAttribute("runId", existingRun.friendlyId);
        return existingRun;
      }

      if (environment.type !== "DEVELOPMENT") {
        const result = await getEntitlement(environment.organizationId);
        if (result && result.hasAccess === false) {
          throw new OutOfEntitlementError();
        }
      }

      return await eventRepository.traceEvent(
        taskId,
        {
          context: options.traceContext,
          spanParentAsLink: options.spanParentAsLink,
          parentAsLinkType: options.parentAsLinkType,
          kind: "SERVER",
          environment,
          taskSlug: taskId,
          attributes: {
            properties: {
              [SemanticInternalAttributes.SHOW_ACTIONS]: true,
            },
            style: {
              icon: options.customIcon ?? "task",
            },
            runIsTest: body.options?.test ?? false,
            batchId: options.batchId,
            idempotencyKey,
          },
          incomplete: true,
          immediate: true,
        },
        async (event, traceContext) => {
          const runFriendlyId = generateFriendlyId("run");

          const payloadPacket = await this.#handlePayloadPacket(
            body.payload,
            body.options?.payloadType ?? "application/json",
            runFriendlyId,
            environment
          );

          const run = await autoIncrementCounter.incrementInTransaction(
            `v3-run:${environment.id}:${taskId}`,
            async (num, tx) => {
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

              let queueName = sanitizeQueueName(body.options?.queue?.name ?? `task/${taskId}`);

              // Check that the queuename is not an empty string
              if (!queueName) {
                queueName = sanitizeQueueName(`task/${taskId}`);
              }

              event.setAttribute("queueName", queueName);
              span.setAttribute("queueName", queueName);

              const taskRun = await tx.taskRun.create({
                data: {
                  status: "PENDING",
                  number: num,
                  friendlyId: runFriendlyId,
                  runtimeEnvironmentId: environment.id,
                  projectId: environment.projectId,
                  idempotencyKey,
                  taskIdentifier: taskId,
                  payload: payloadPacket.data ?? "",
                  payloadType: payloadPacket.dataType,
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

              if (payloadPacket.data) {
                if (
                  payloadPacket.dataType === "application/json" ||
                  payloadPacket.dataType === "application/super+json"
                ) {
                  event.setAttribute("payload", JSON.parse(payloadPacket.data) as any);
                } else {
                  event.setAttribute("payload", payloadPacket.data);
                }

                event.setAttribute("payloadType", payloadPacket.dataType);
              }

              event.setAttribute("runId", taskRun.friendlyId);
              span.setAttribute("runId", taskRun.friendlyId);

              if (body.options?.dependentAttempt) {
                const dependentAttempt = await tx.taskRunAttempt.findUnique({
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

              if (body.options?.queue) {
                const concurrencyLimit = body.options.queue.concurrencyLimit
                  ? Math.max(0, body.options.queue.concurrencyLimit)
                  : null;
                const taskQueue = await prisma.taskQueue.upsert({
                  where: {
                    runtimeEnvironmentId_name: {
                      runtimeEnvironmentId: environment.id,
                      name: queueName,
                    },
                  },
                  update: {
                    concurrencyLimit,
                    rateLimit: body.options.queue.rateLimit,
                  },
                  create: {
                    friendlyId: generateFriendlyId("queue"),
                    name: queueName,
                    concurrencyLimit,
                    runtimeEnvironmentId: environment.id,
                    projectId: environment.projectId,
                    rateLimit: body.options.queue.rateLimit,
                    type: "NAMED",
                  },
                });

                if (typeof taskQueue.concurrencyLimit === "number") {
                  await marqs?.updateQueueConcurrencyLimits(
                    environment,
                    taskQueue.name,
                    taskQueue.concurrencyLimit
                  );
                } else {
                  await marqs?.removeQueueConcurrencyLimits(environment, taskQueue.name);
                }
              }

              return taskRun;
            },
            async (_, tx) => {
              const counter = await tx.taskRunNumberCounter.findUnique({
                where: {
                  taskIdentifier_environmentId: {
                    taskIdentifier: taskId,
                    environmentId: environment.id,
                  },
                },
                select: { lastNumber: true },
              });

              return counter?.lastNumber;
            },
            this._prisma
          );

          if (!run) {
            return;
          }

          // We need to enqueue the task run into the appropriate queue. This is done after the tx completes to prevent a race condition where the task run hasn't been created yet by the time we dequeue.
          await marqs?.enqueueMessage(
            environment,
            run.queue,
            run.id,
            { type: "EXECUTE", taskIdentifier: taskId },
            body.options?.concurrencyKey
          );

          return run;
        }
      );
    });
  }

  async #handlePayloadPacket(
    payload: any,
    payloadType: string,
    pathPrefix: string,
    environment: AuthenticatedEnvironment
  ) {
    const packet = this.#createPayloadPacket(payload, payloadType);

    if (!packet.data) {
      return packet;
    }

    const { needsOffloading, size } = packetRequiresOffloading(packet);

    if (!needsOffloading) {
      return packet;
    }

    const filename = `${pathPrefix}/payload.json`;

    await uploadToObjectStore(filename, packet.data, packet.dataType, environment);

    return {
      data: filename,
      dataType: "application/store",
    };
  }

  #createPayloadPacket(payload: any, payloadType: string): IOPacket {
    if (payloadType === "application/json") {
      return { data: JSON.stringify(payload), dataType: "application/json" };
    }

    if (typeof payload === "string") {
      return { data: payload, dataType: payloadType };
    }

    return { dataType: payloadType };
  }
}
