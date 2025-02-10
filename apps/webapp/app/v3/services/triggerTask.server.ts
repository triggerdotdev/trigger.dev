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
import { marqs } from "~/v3/marqs/index.server";
import { eventRepository } from "../eventRepository.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { uploadPacketToObjectStore } from "../r2.server";
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
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";
import { Prisma, TaskRun } from "@trigger.dev/database";
import { sanitizeQueueName } from "~/models/taskQueue.server";
import { EnqueueDelayedRunService } from "./enqueueDelayedRun.server";
import { getTaskEventStore } from "../taskEventStore.server";

export type TriggerTaskServiceOptions = {
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined>;
  spanParentAsLink?: boolean;
  parentAsLinkType?: "replay" | "trigger";
  batchId?: string;
  customIcon?: string;
  runId?: string;
  skipChecks?: boolean;
  oneTimeUseToken?: string;
};

export class OutOfEntitlementError extends Error {
  constructor() {
    super("You can't trigger a task because you have run out of credits.");
  }
}

export type TriggerTaskServiceResult = {
  run: TaskRun;
  isCached: boolean;
};

const MAX_ATTEMPTS = 2;

export class TriggerTaskService extends BaseService {
  public async call(
    taskId: string,
    environment: AuthenticatedEnvironment,
    body: TriggerTaskRequestBody,
    options: TriggerTaskServiceOptions = {},
    attempt: number = 0
  ): Promise<TriggerTaskServiceResult | undefined> {
    return await this.traceWithEnv("call()", environment, async (span) => {
      span.setAttribute("taskId", taskId);
      span.setAttribute("attempt", attempt);

      if (attempt > MAX_ATTEMPTS) {
        throw new ServiceValidationError(
          `Failed to trigger ${taskId} after ${MAX_ATTEMPTS} attempts.`
        );
      }

      // TODO: Add idempotency key expiring here
      const idempotencyKey = options.idempotencyKey ?? body.options?.idempotencyKey;
      const idempotencyKeyExpiresAt =
        options.idempotencyKeyExpiresAt ??
        resolveIdempotencyKeyTTL(body.options?.idempotencyKeyTTL) ??
        new Date(Date.now() + 24 * 60 * 60 * 1000 * 30); // 30 days

      const delayUntil = await parseDelay(body.options?.delay);

      const ttl =
        typeof body.options?.ttl === "number"
          ? stringifyDuration(body.options?.ttl)
          : body.options?.ttl ?? (environment.type === "DEVELOPMENT" ? "10m" : undefined);

      const existingRun = idempotencyKey
        ? await this._prisma.taskRun.findFirst({
            where: {
              runtimeEnvironmentId: environment.id,
              idempotencyKey,
              taskIdentifier: taskId,
            },
          })
        : undefined;

      if (existingRun) {
        if (
          existingRun.idempotencyKeyExpiresAt &&
          existingRun.idempotencyKeyExpiresAt < new Date()
        ) {
          logger.debug("[TriggerTaskService][call] Idempotency key has expired", {
            idempotencyKey: options.idempotencyKey,
            run: existingRun,
          });

          // Update the existing batch to remove the idempotency key
          await this._prisma.taskRun.update({
            where: { id: existingRun.id },
            data: { idempotencyKey: null },
          });
        } else {
          span.setAttribute("runId", existingRun.friendlyId);

          return { run: existingRun, isCached: true };
        }
      }

      if (environment.type !== "DEVELOPMENT" && !options.skipChecks) {
        const result = await getEntitlement(environment.organizationId);
        if (result && result.hasAccess === false) {
          throw new OutOfEntitlementError();
        }
      }

      if (!options.skipChecks) {
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

      const runFriendlyId = options?.runId ?? generateFriendlyId("run");

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
        ? await this._prisma.taskRunAttempt.findFirst({
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
        ? await this._prisma.taskRunAttempt.findFirst({
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
        ? await this._prisma.batchTaskRun.findFirst({
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
        ? await this._prisma.batchTaskRun.findFirst({
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

      try {
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
                  ? await tx.backgroundWorker.findFirst({
                      where: {
                        projectId: environment.projectId,
                        runtimeEnvironmentId: environment.id,
                        version: body.options?.lockToVersion,
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
                    idempotencyKeyExpiresAt: idempotencyKey ? idempotencyKeyExpiresAt : undefined,
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
                    taskVersion: lockedToBackgroundWorker?.version,
                    sdkVersion: lockedToBackgroundWorker?.sdkVersion,
                    cliVersion: lockedToBackgroundWorker?.cliVersion,
                    concurrencyKey: body.options?.concurrencyKey,
                    queue: queueName,
                    isTest: body.options?.test ?? false,
                    delayUntil,
                    queuedAt: delayUntil ? undefined : new Date(),
                    maxAttempts: body.options?.maxAttempts,
                    taskEventStore: getTaskEventStore(),
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
                    oneTimeUseToken: options.oneTimeUseToken,
                    machinePreset: body.options?.machine,
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
                    typeof body.options.queue?.concurrencyLimit === "number"
                      ? Math.max(
                          Math.min(
                            body.options.queue.concurrencyLimit,
                            environment.maximumConcurrencyLimit,
                            environment.organization.maximumConcurrencyLimit
                          ),
                          0
                        )
                      : body.options.queue?.concurrencyLimit;

                  let taskQueue = await tx.taskQueue.findFirst({
                    where: {
                      runtimeEnvironmentId: environment.id,
                      name: queueName,
                    },
                  });

                  if (!taskQueue) {
                    // handle conflicts with existing queues
                    taskQueue = await tx.taskQueue.create({
                      data: {
                        friendlyId: generateFriendlyId("queue"),
                        name: queueName,
                        concurrencyLimit,
                        runtimeEnvironmentId: environment.id,
                        projectId: environment.projectId,
                        type: "NAMED",
                      },
                    });
                  }

                  if (typeof concurrencyLimit === "number") {
                    logger.debug("TriggerTaskService: updating concurrency limit", {
                      runId: taskRun.id,
                      friendlyId: taskRun.friendlyId,
                      taskQueue,
                      orgId: environment.organizationId,
                      projectId: environment.projectId,
                      concurrencyLimit,
                      queueOptions: body.options?.queue,
                    });

                    await marqs?.updateQueueConcurrencyLimits(
                      environment,
                      taskQueue.name,
                      concurrencyLimit
                    );
                  } else if (concurrencyLimit === null) {
                    logger.debug("TriggerTaskService: removing concurrency limit", {
                      runId: taskRun.id,
                      friendlyId: taskRun.friendlyId,
                      taskQueue,
                      orgId: environment.organizationId,
                      projectId: environment.projectId,
                      queueOptions: body.options?.queue,
                    });

                    await marqs?.removeQueueConcurrencyLimits(environment, taskQueue.name);
                  }
                }

                if (taskRun.delayUntil) {
                  await EnqueueDelayedRunService.enqueue(taskRun.id, taskRun.delayUntil);
                }

                if (!taskRun.delayUntil && taskRun.ttl) {
                  const expireAt = parseNaturalLanguageDuration(taskRun.ttl);

                  if (expireAt) {
                    await ExpireEnqueuedRunService.enqueue(taskRun.id, expireAt);
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

            // If this is a triggerAndWait or batchTriggerAndWait,
            // we need to add the parent run to the reserve concurrency set
            // to free up concurrency for the children to run
            if (dependentAttempt) {
              await marqs?.reserveConcurrency(dependentAttempt.taskRun.id);
            } else if (dependentBatchRun?.dependentTaskAttempt) {
              await marqs?.reserveConcurrency(dependentBatchRun.dependentTaskAttempt.taskRun.id);
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

            return { run, isCached: false };
          }
        );
      } catch (error) {
        // Detect a prisma transaction Unique constraint violation
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          logger.debug("TriggerTask: Prisma transaction error", {
            code: error.code,
            message: error.message,
            meta: error.meta,
          });

          if (error.code === "P2002") {
            const target = error.meta?.target;

            if (
              Array.isArray(target) &&
              target.length > 0 &&
              typeof target[0] === "string" &&
              target[0].includes("oneTimeUseToken")
            ) {
              throw new ServiceValidationError(
                `Cannot trigger ${taskId} with a one-time use token as it has already been used.`
              );
            } else if (
              Array.isArray(target) &&
              target.length == 2 &&
              typeof target[0] === "string" &&
              typeof target[1] === "string" &&
              target[0] == "runtimeEnvironmentId" &&
              target[1] == "name" &&
              error.message.includes("prisma.taskQueue.create")
            ) {
              throw new Error(
                `Failed to trigger ${taskId} as the queue could not be created do to a unique constraint error, please try again.`
              );
            } else if (
              Array.isArray(target) &&
              target.length == 3 &&
              typeof target[0] === "string" &&
              typeof target[1] === "string" &&
              typeof target[2] === "string" &&
              target[0] == "runtimeEnvironmentId" &&
              target[1] == "taskIdentifier" &&
              target[2] == "idempotencyKey"
            ) {
              logger.debug("TriggerTask: Idempotency key violation, retrying...", {
                taskId,
                environmentId: environment.id,
                idempotencyKey,
              });
              // We need to retry the task run creation as the idempotency key has been used
              return await this.call(taskId, environment, body, options, attempt + 1);
            } else {
              throw new ServiceValidationError(
                `Cannot trigger ${taskId} as it has already been triggered with the same idempotency key.`
              );
            }
          }
        }

        throw error;
      }
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

    const task = await this._prisma.backgroundWorkerTask.findFirst({
      where: {
        workerId: worker.id,
        slug: taskId,
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

      await uploadPacketToObjectStore(filename, packet.data, packet.dataType, environment);

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
