import {
  IOPacket,
  QueueOptions,
  SemanticInternalAttributes,
  TriggerTaskRequestBody,
  packetRequiresOffloading,
} from "@trigger.dev/core/v3";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { autoIncrementCounter } from "~/services/autoIncrementCounter.server";
import { workerQueue } from "~/services/worker.server";
import { marqs, sanitizeQueueName } from "~/v3/marqs/index.server";
import { eventRepository } from "../eventRepository.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { uploadToObjectStore } from "../r2.server";
import { startActiveSpan } from "../tracer.server";
import { getEntitlement } from "~/services/platform.v3.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { logger } from "~/services/logger.server";
import { isFinalAttemptStatus, isFinalRunStatus } from "../taskStatus";
import { createTag, MAX_TAGS_PER_RUN } from "~/models/taskRunTag.server";
import { findCurrentWorkerFromEnvironment } from "../models/workerDeployment.server";
import { handleMetadataPacket } from "~/utils/packets";
import { parseNaturalLanguageDuration } from "@trigger.dev/core/v3/apps";
import { ExpireEnqueuedRunService } from "./expireEnqueuedRun.server";
import { guardQueueSizeLimitsForEnv } from "../queueSizeLimits.server";
import { clampMaxDuration } from "../utils/maxDuration";

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
      const delayUntil = await parseDelay(body.options?.delay);

      const ttl =
        typeof body.options?.ttl === "number"
          ? stringifyDuration(body.options?.ttl)
          : body.options?.ttl ?? (environment.type === "DEVELOPMENT" ? "10m" : undefined);

      const existingRun = idempotencyKey
        ? await this._prisma.taskRun.findUnique({
            where: {
              runtimeEnvironmentId_taskIdentifier_idempotencyKey: {
                runtimeEnvironmentId: environment.id,
                idempotencyKey,
                taskIdentifier: taskId,
              },
            },
          })
        : undefined;

      if (existingRun) {
        span.setAttribute("runId", existingRun.friendlyId);

        return existingRun;
      }

      if (environment.type !== "DEVELOPMENT") {
        const result = await getEntitlement(environment.organizationId);
        if (result && result.hasAccess === false) {
          throw new OutOfEntitlementError();
        }
      }

      const queueSizeGuard = await guardQueueSizeLimitsForEnv(environment, marqs);

      logger.debug("Queue size guard result", {
        queueSizeGuard,
        environment: {
          id: environment.id,
          type: environment.type,
          organization: environment.organization,
          project: environment.project,
        },
      });

      if (!queueSizeGuard.isWithinLimits) {
        throw new ServiceValidationError(
          `Cannot trigger ${taskId} as the queue size limit for this environment has been reached. The maximum size is ${queueSizeGuard.maximumSize}`
        );
      }

      if (
        body.options?.tags &&
        typeof body.options.tags !== "string" &&
        body.options.tags.length > MAX_TAGS_PER_RUN
      ) {
        throw new ServiceValidationError(
          `Runs can only have ${MAX_TAGS_PER_RUN} tags, you're trying to set ${body.options.tags.length}.`
        );
      }

      const runFriendlyId = generateFriendlyId("run");

      const payloadPacket = await this.#handlePayloadPacket(
        body.payload,
        body.options?.payloadType ?? "application/json",
        runFriendlyId,
        environment
      );

      const metadataPacket = body.options?.metadata
        ? handleMetadataPacket(
            body.options?.metadata,
            body.options?.metadataType ?? "application/json"
          )
        : undefined;

      const dependentAttempt = body.options?.dependentAttempt
        ? await this._prisma.taskRunAttempt.findUnique({
            where: { friendlyId: body.options.dependentAttempt },
            include: {
              taskRun: {
                select: {
                  id: true,
                  status: true,
                  taskIdentifier: true,
                  rootTaskRunId: true,
                  depth: true,
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
            `Cannot trigger ${taskId} as the parent attempt has a status of ${dependentAttempt.status}`
          );
        } else {
          throw new ServiceValidationError(
            `Cannot trigger ${taskId} as the parent run has a status of ${dependentAttempt.taskRun.status}`
          );
        }
      }

      const parentAttempt = body.options?.parentAttempt
        ? await this._prisma.taskRunAttempt.findUnique({
            where: { friendlyId: body.options.parentAttempt },
            include: {
              taskRun: {
                select: {
                  id: true,
                  status: true,
                  taskIdentifier: true,
                  rootTaskRunId: true,
                  depth: true,
                },
              },
            },
          })
        : undefined;

      const dependentBatchRun = body.options?.dependentBatch
        ? await this._prisma.batchTaskRun.findUnique({
            where: { friendlyId: body.options.dependentBatch },
            include: {
              dependentTaskAttempt: {
                include: {
                  taskRun: {
                    select: {
                      id: true,
                      status: true,
                      taskIdentifier: true,
                      rootTaskRunId: true,
                      depth: true,
                    },
                  },
                },
              },
            },
          })
        : undefined;

      if (
        dependentBatchRun &&
        dependentBatchRun.dependentTaskAttempt &&
        (isFinalAttemptStatus(dependentBatchRun.dependentTaskAttempt.status) ||
          isFinalRunStatus(dependentBatchRun.dependentTaskAttempt.taskRun.status))
      ) {
        logger.debug("Dependent batch run task attempt or run has been canceled", {
          dependentBatchRunId: dependentBatchRun.id,
          status: dependentBatchRun.status,
          attempt: dependentBatchRun.dependentTaskAttempt,
        });

        if (isFinalAttemptStatus(dependentBatchRun.dependentTaskAttempt.status)) {
          throw new ServiceValidationError(
            `Cannot trigger ${taskId} as the parent attempt has a status of ${dependentBatchRun.dependentTaskAttempt.status}`
          );
        } else {
          throw new ServiceValidationError(
            `Cannot trigger ${taskId} as the parent run has a status of ${dependentBatchRun.dependentTaskAttempt.taskRun.status}`
          );
        }
      }

      const parentBatchRun = body.options?.parentBatch
        ? await this._prisma.batchTaskRun.findUnique({
            where: { friendlyId: body.options.parentBatch },
            include: {
              dependentTaskAttempt: {
                include: {
                  taskRun: {
                    select: {
                      id: true,
                      status: true,
                      taskIdentifier: true,
                      rootTaskRunId: true,
                    },
                  },
                },
              },
            },
          })
        : undefined;

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
        async (event, traceContext, traceparent) => {
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

              let queueName = sanitizeQueueName(
                await this.#getQueueName(taskId, environment, body.options?.queue?.name)
              );

              // Check that the queuename is not an empty string
              if (!queueName) {
                queueName = sanitizeQueueName(`task/${taskId}`);
              }

              event.setAttribute("queueName", queueName);
              span.setAttribute("queueName", queueName);

              //upsert tags
              let tagIds: string[] = [];
              const bodyTags =
                typeof body.options?.tags === "string" ? [body.options.tags] : body.options?.tags;
              if (bodyTags && bodyTags.length > 0) {
                for (const tag of bodyTags) {
                  const tagRecord = await createTag({
                    tag,
                    projectId: environment.projectId,
                  });
                  if (tagRecord) {
                    tagIds.push(tagRecord.id);
                  }
                }
              }

              const depth = dependentAttempt
                ? dependentAttempt.taskRun.depth + 1
                : parentAttempt
                ? parentAttempt.taskRun.depth + 1
                : dependentBatchRun?.dependentTaskAttempt
                ? dependentBatchRun.dependentTaskAttempt.taskRun.depth + 1
                : 0;

              const taskRun = await tx.taskRun.create({
                data: {
                  status: delayUntil ? "DELAYED" : "PENDING",
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
                  parentSpanId:
                    options.parentAsLinkType === "replay" ? undefined : traceparent?.spanId,
                  lockedToVersionId: lockedToBackgroundWorker?.id,
                  concurrencyKey: body.options?.concurrencyKey,
                  queue: queueName,
                  isTest: body.options?.test ?? false,
                  delayUntil,
                  queuedAt: delayUntil ? undefined : new Date(),
                  maxAttempts: body.options?.maxAttempts,
                  ttl,
                  tags:
                    tagIds.length === 0
                      ? undefined
                      : {
                          connect: tagIds.map((id) => ({ id })),
                        },
                  parentTaskRunId:
                    dependentAttempt?.taskRun.id ??
                    parentAttempt?.taskRun.id ??
                    dependentBatchRun?.dependentTaskAttempt?.taskRun.id,
                  parentTaskRunAttemptId:
                    dependentAttempt?.id ??
                    parentAttempt?.id ??
                    dependentBatchRun?.dependentTaskAttempt?.id,
                  rootTaskRunId:
                    dependentAttempt?.taskRun.rootTaskRunId ??
                    dependentAttempt?.taskRun.id ??
                    parentAttempt?.taskRun.rootTaskRunId ??
                    parentAttempt?.taskRun.id ??
                    dependentBatchRun?.dependentTaskAttempt?.taskRun.rootTaskRunId ??
                    dependentBatchRun?.dependentTaskAttempt?.taskRun.id,
                  batchId: dependentBatchRun?.id ?? parentBatchRun?.id,
                  resumeParentOnCompletion: !!(dependentAttempt ?? dependentBatchRun),
                  depth,
                  metadata: metadataPacket?.data,
                  metadataType: metadataPacket?.dataType,
                  seedMetadata: metadataPacket?.data,
                  seedMetadataType: metadataPacket?.dataType,
                  maxDurationInSeconds: body.options?.maxDuration
                    ? clampMaxDuration(body.options.maxDuration)
                    : undefined,
                  runTags: bodyTags,
                },
              });

              event.setAttribute("runId", taskRun.friendlyId);
              span.setAttribute("runId", taskRun.friendlyId);

              if (dependentAttempt) {
                await tx.taskRunDependency.create({
                  data: {
                    taskRunId: taskRun.id,
                    dependentAttemptId: dependentAttempt.id,
                  },
                });
              } else if (dependentBatchRun) {
                await tx.taskRunDependency.create({
                  data: {
                    taskRunId: taskRun.id,
                    dependentBatchRunId: dependentBatchRun.id,
                  },
                });
              }

              if (body.options?.queue) {
                const concurrencyLimit =
                  typeof body.options.queue.concurrencyLimit === "number"
                    ? Math.max(0, body.options.queue.concurrencyLimit)
                    : undefined;

                let taskQueue = await tx.taskQueue.findFirst({
                  where: {
                    runtimeEnvironmentId: environment.id,
                    name: queueName,
                  },
                });

                if (taskQueue) {
                  taskQueue = await tx.taskQueue.update({
                    where: {
                      id: taskQueue.id,
                    },
                    data: {
                      concurrencyLimit,
                      rateLimit: body.options.queue.rateLimit,
                    },
                  });
                } else {
                  taskQueue = await tx.taskQueue.create({
                    data: {
                      friendlyId: generateFriendlyId("queue"),
                      name: queueName,
                      concurrencyLimit,
                      runtimeEnvironmentId: environment.id,
                      projectId: environment.projectId,
                      rateLimit: body.options.queue.rateLimit,
                      type: "NAMED",
                    },
                  });
                }

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

              if (taskRun.delayUntil) {
                await workerQueue.enqueue(
                  "v3.enqueueDelayedRun",
                  { runId: taskRun.id },
                  { tx, runAt: delayUntil, jobKey: `v3.enqueueDelayedRun.${taskRun.id}` }
                );
              }

              if (!taskRun.delayUntil && taskRun.ttl) {
                const expireAt = parseNaturalLanguageDuration(taskRun.ttl);

                if (expireAt) {
                  await ExpireEnqueuedRunService.enqueue(taskRun.id, expireAt, tx);
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

          //release the concurrency for the env and org, if part of a (batch)triggerAndWait
          if (dependentAttempt) {
            const isSameTask = dependentAttempt.taskRun.taskIdentifier === taskId;
            await marqs?.releaseConcurrency(dependentAttempt.taskRun.id, isSameTask);
          }
          if (dependentBatchRun?.dependentTaskAttempt) {
            const isSameTask =
              dependentBatchRun.dependentTaskAttempt.taskRun.taskIdentifier === taskId;
            await marqs?.releaseConcurrency(
              dependentBatchRun.dependentTaskAttempt.taskRun.id,
              isSameTask
            );
          }

          if (!run) {
            return;
          }

          // We need to enqueue the task run into the appropriate queue. This is done after the tx completes to prevent a race condition where the task run hasn't been created yet by the time we dequeue.
          if (run.status === "PENDING") {
            await marqs?.enqueueMessage(
              environment,
              run.queue,
              run.id,
              {
                type: "EXECUTE",
                taskIdentifier: taskId,
                projectId: environment.projectId,
                environmentId: environment.id,
                environmentType: environment.type,
              },
              body.options?.concurrencyKey
            );
          }

          return run;
        }
      );
    });
  }

  async #getQueueName(taskId: string, environment: AuthenticatedEnvironment, queueName?: string) {
    if (queueName) {
      return queueName;
    }

    const defaultQueueName = `task/${taskId}`;

    const worker = await findCurrentWorkerFromEnvironment(environment);

    if (!worker) {
      logger.debug("Failed to get queue name: No worker found", {
        taskId,
        environmentId: environment.id,
      });

      return defaultQueueName;
    }

    const task = await this._prisma.backgroundWorkerTask.findUnique({
      where: {
        workerId_slug: {
          workerId: worker.id,
          slug: taskId,
        },
      },
    });

    if (!task) {
      console.log("Failed to get queue name: No task found", {
        taskId,
        environmentId: environment.id,
      });

      return defaultQueueName;
    }

    const queueConfig = QueueOptions.optional().nullable().safeParse(task.queueConfig);

    if (!queueConfig.success) {
      console.log("Failed to get queue name: Invalid queue config", {
        taskId,
        environmentId: environment.id,
        queueConfig: task.queueConfig,
      });

      return defaultQueueName;
    }

    return queueConfig.data?.name ?? defaultQueueName;
  }

  async #handlePayloadPacket(
    payload: any,
    payloadType: string,
    pathPrefix: string,
    environment: AuthenticatedEnvironment
  ) {
    return await startActiveSpan("handlePayloadPacket()", async (span) => {
      const packet = this.#createPayloadPacket(payload, payloadType);

      if (!packet.data) {
        return packet;
      }

      const { needsOffloading, size } = packetRequiresOffloading(
        packet,
        env.TASK_PAYLOAD_OFFLOAD_THRESHOLD
      );

      if (!needsOffloading) {
        return packet;
      }

      const filename = `${pathPrefix}/payload.json`;

      await uploadToObjectStore(filename, packet.data, packet.dataType, environment);

      return {
        data: filename,
        dataType: "application/store",
      };
    });
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

export async function parseDelay(value?: string | Date): Promise<Date | undefined> {
  if (!value) {
    return;
  }

  if (value instanceof Date) {
    return value;
  }

  try {
    const date = new Date(value);

    // Check if the date is valid
    if (isNaN(date.getTime())) {
      return parseNaturalLanguageDuration(value);
    }

    if (date.getTime() <= Date.now()) {
      return;
    }

    return date;
  } catch (error) {
    return parseNaturalLanguageDuration(value);
  }
}

function stringifyDuration(seconds: number): string | undefined {
  if (seconds <= 0) {
    return;
  }

  const units = {
    w: Math.floor(seconds / 604800),
    d: Math.floor((seconds % 604800) / 86400),
    h: Math.floor((seconds % 86400) / 3600),
    m: Math.floor((seconds % 3600) / 60),
    s: Math.floor(seconds % 60),
  };

  // Filter the units having non-zero values and join them
  const result: string = Object.entries(units)
    .filter(([unit, val]) => val != 0)
    .map(([unit, val]) => `${val}${unit}`)
    .join("");

  return result;
}
