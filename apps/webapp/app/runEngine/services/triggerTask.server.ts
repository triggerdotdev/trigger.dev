import { RunDuplicateIdempotencyKeyError, RunEngine } from "@internal/run-engine";
import {
  IOPacket,
  packetRequiresOffloading,
  SemanticInternalAttributes,
  TaskRunError,
  taskRunErrorEnhancer,
  taskRunErrorToString,
  TriggerTaskRequestBody,
} from "@trigger.dev/core/v3";
import {
  BatchId,
  RunId,
  sanitizeQueueName,
  stringifyDuration,
} from "@trigger.dev/core/v3/isomorphic";
import { Prisma } from "@trigger.dev/database";
import { env } from "~/env.server";
import { createTags, MAX_TAGS_PER_RUN } from "~/models/taskRunTag.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { autoIncrementCounter } from "~/services/autoIncrementCounter.server";
import { logger } from "~/services/logger.server";
import { getEntitlement } from "~/services/platform.v3.server";
import { parseDelay } from "~/utils/delays";
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";
import { handleMetadataPacket } from "~/utils/packets";
import { eventRepository } from "../../v3/eventRepository.server";
import { findCurrentWorkerFromEnvironment } from "../../v3/models/workerDeployment.server";
import { uploadPacketToObjectStore } from "../../v3/r2.server";
import { getTaskEventStore } from "../../v3/taskEventStore.server";
import { isFinalRunStatus } from "../../v3/taskStatus";
import { startActiveSpan } from "../../v3/tracer.server";
import { clampMaxDuration } from "../../v3/utils/maxDuration";
import { ServiceValidationError, WithRunEngine } from "../../v3/services/baseService.server";
import {
  MAX_ATTEMPTS,
  OutOfEntitlementError,
  TriggerTaskServiceOptions,
  TriggerTaskServiceResult,
} from "../../v3/services/triggerTask.server";
import { WorkerGroupService } from "../../v3/services/worker/workerGroupService.server";

export class RunEngineTriggerTaskService extends WithRunEngine {
  public async call({
    taskId,
    environment,
    body,
    options = {},
    attempt = 0,
  }: {
    taskId: string;
    environment: AuthenticatedEnvironment;
    body: TriggerTaskRequestBody;
    options?: TriggerTaskServiceOptions;
    attempt?: number;
  }): Promise<TriggerTaskServiceResult | undefined> {
    return await this.traceWithEnv("call()", environment, async (span) => {
      span.setAttribute("taskId", taskId);
      span.setAttribute("attempt", attempt);

      if (attempt > MAX_ATTEMPTS) {
        throw new ServiceValidationError(
          `Failed to trigger ${taskId} after ${MAX_ATTEMPTS} attempts.`
        );
      }

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
            include: {
              associatedWaitpoint: true,
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

          // Update the existing run to remove the idempotency key
          await this._prisma.taskRun.update({
            where: { id: existingRun.id },
            data: { idempotencyKey: null },
          });
        } else {
          span.setAttribute("runId", existingRun.friendlyId);

          //We're using `andWait` so we need to block the parent run with a waitpoint
          if (
            existingRun.associatedWaitpoint &&
            body.options?.resumeParentOnCompletion &&
            body.options?.parentRunId
          ) {
            await eventRepository.traceEvent(
              `${taskId} (cached)`,
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
                    [SemanticInternalAttributes.ORIGINAL_RUN_ID]: existingRun.friendlyId,
                  },
                  style: {
                    icon: "task-cached",
                  },
                  runIsTest: body.options?.test ?? false,
                  batchId: options.batchId ? BatchId.toFriendlyId(options.batchId) : undefined,
                  idempotencyKey,
                  runId: existingRun.friendlyId,
                },
                incomplete: existingRun.associatedWaitpoint.status === "PENDING",
                isError: existingRun.associatedWaitpoint.outputIsError,
                immediate: true,
              },
              async (event) => {
                //log a message
                await eventRepository.recordEvent(
                  `There's an existing run for idempotencyKey: ${idempotencyKey}`,
                  {
                    taskSlug: taskId,
                    environment,
                    attributes: {
                      runId: existingRun.friendlyId,
                    },
                    context: options.traceContext,
                    parentId: event.spanId,
                  }
                );
                //block run with waitpoint
                await this._engine.blockRunWithWaitpoint({
                  runId: RunId.fromFriendlyId(body.options!.parentRunId!),
                  waitpoints: existingRun.associatedWaitpoint!.id,
                  spanIdToComplete: event.spanId,
                  batch: options?.batchId
                    ? {
                        id: options.batchId,
                        index: options.batchIndex ?? 0,
                      }
                    : undefined,
                  projectId: environment.projectId,
                  organizationId: environment.organizationId,
                  tx: this._prisma,
                  releaseConcurrency: body.options?.releaseConcurrency,
                });
              }
            );
          }

          return { run: existingRun, isCached: true };
        }
      }

      if (environment.type !== "DEVELOPMENT") {
        const result = await getEntitlement(environment.organizationId);
        if (result && result.hasAccess === false) {
          throw new OutOfEntitlementError();
        }
      }

      if (!options.skipChecks) {
        const queueSizeGuard = await guardQueueSizeLimitsForEnv(this._engine, environment);

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

      const runFriendlyId = options?.runFriendlyId ?? RunId.generate().friendlyId;

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

      const parentRun = body.options?.parentRunId
        ? await this._prisma.taskRun.findFirst({
            where: { id: RunId.fromFriendlyId(body.options.parentRunId) },
          })
        : undefined;

      if (
        parentRun &&
        isFinalRunStatus(parentRun.status) &&
        body.options?.resumeParentOnCompletion
      ) {
        logger.debug("Parent run is in a terminal state", {
          parentRun,
        });

        throw new ServiceValidationError(
          `Cannot trigger ${taskId} as the parent run has a status of ${parentRun.status}`
        );
      }

      const lockedToBackgroundWorker = body.options?.lockToVersion
        ? await this._prisma.backgroundWorker.findFirst({
            where: {
              projectId: environment.projectId,
              runtimeEnvironmentId: environment.id,
              version: body.options?.lockToVersion,
            },
            select: {
              id: true,
              version: true,
              sdkVersion: true,
              cliVersion: true,
            },
          })
        : undefined;

      let queueName: string;
      let lockedQueueId: string | undefined;

      // Determine queue name based on lockToVersion and provided options
      if (lockedToBackgroundWorker) {
        // Task is locked to a specific worker version
        if (body.options?.queue?.name) {
          const specifiedQueueName = body.options.queue.name;
          // A specific queue name is provided
          const specifiedQueue = await this._prisma.taskQueue.findFirst({
            // Validate it exists for the locked worker
            where: {
              name: specifiedQueueName,
              workers: { some: { id: lockedToBackgroundWorker.id } }, // Ensure the queue is associated with any task of the locked worker
            },
          });

          if (!specifiedQueue) {
            throw new ServiceValidationError(
              `Specified queue '${specifiedQueueName}' not found or not associated with locked version '${
                body.options?.lockToVersion ?? "<unknown>"
              }'.`
            );
          }
          // Use the validated queue name directly
          queueName = specifiedQueue.name;
          lockedQueueId = specifiedQueue.id;
        } else {
          // No specific queue name provided, use the default queue for the task on the locked worker
          const lockedTask = await this._prisma.backgroundWorkerTask.findFirst({
            where: {
              workerId: lockedToBackgroundWorker.id,
              slug: taskId,
            },
            include: {
              queue: true,
            },
          });

          if (!lockedTask) {
            throw new ServiceValidationError(
              `Task '${taskId}' not found on locked version '${
                body.options?.lockToVersion ?? "<unknown>"
              }'.`
            );
          }

          if (!lockedTask.queue) {
            // This case should ideally be prevented by earlier checks or schema constraints,
            // but handle it defensively.
            logger.error("Task found on locked version, but has no associated queue record", {
              taskId,
              workerId: lockedToBackgroundWorker.id,
              version: lockedToBackgroundWorker.version,
            });
            throw new ServiceValidationError(
              `Default queue configuration for task '${taskId}' missing on locked version '${
                body.options?.lockToVersion ?? "<unknown>"
              }'.`
            );
          }
          // Use the task's default queue name
          queueName = lockedTask.queue.name;
          lockedQueueId = lockedTask.queue.id;
        }
      } else {
        // Task is not locked to a specific version, use regular logic
        if (body.options?.lockToVersion) {
          // This should only happen if the findFirst failed, indicating the version doesn't exist
          throw new ServiceValidationError(
            `Task locked to version '${body.options.lockToVersion}', but no worker found with that version.`
          );
        }

        // Get queue name using the helper for non-locked case (handles provided name or finds default)
        queueName = await this.#getQueueName(taskId, environment, body.options?.queue?.name);
      }

      // Sanitize the final determined queue name once
      const sanitizedQueueName = sanitizeQueueName(queueName);

      // Check that the queuename is not an empty string
      if (!sanitizedQueueName) {
        queueName = sanitizeQueueName(`task/${taskId}`); // Fallback if sanitization results in empty
      } else {
        queueName = sanitizedQueueName;
      }

      //upsert tags
      const tags = await createTags(
        {
          tags: body.options?.tags,
          projectId: environment.projectId,
        },
        this._prisma
      );

      const depth = parentRun ? parentRun.depth + 1 : 0;

      const masterQueue = await this.#getMasterQueueForEnvironment(environment);

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
              batchId: options.batchId ? BatchId.toFriendlyId(options.batchId) : undefined,
              idempotencyKey,
            },
            incomplete: true,
            immediate: true,
          },
          async (event, traceContext, traceparent) => {
            const result = await autoIncrementCounter.incrementInTransaction(
              `v3-run:${environment.id}:${taskId}`,
              async (num, tx) => {
                event.setAttribute("queueName", queueName);
                span.setAttribute("queueName", queueName);
                event.setAttribute("runId", runFriendlyId);
                span.setAttribute("runId", runFriendlyId);

                const taskRun = await this._engine.trigger(
                  {
                    number: num,
                    friendlyId: runFriendlyId,
                    environment: environment,
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
                    lockedQueueId,
                    masterQueue: masterQueue,
                    isTest: body.options?.test ?? false,
                    delayUntil,
                    queuedAt: delayUntil ? undefined : new Date(),
                    maxAttempts: body.options?.maxAttempts,
                    taskEventStore: getTaskEventStore(),
                    ttl,
                    tags,
                    oneTimeUseToken: options.oneTimeUseToken,
                    parentTaskRunId: parentRun?.id,
                    rootTaskRunId: parentRun?.rootTaskRunId ?? parentRun?.id,
                    batch: options?.batchId
                      ? {
                          id: options.batchId,
                          index: options.batchIndex ?? 0,
                        }
                      : undefined,
                    resumeParentOnCompletion: body.options?.resumeParentOnCompletion,
                    depth,
                    metadata: metadataPacket?.data,
                    metadataType: metadataPacket?.dataType,
                    seedMetadata: metadataPacket?.data,
                    seedMetadataType: metadataPacket?.dataType,
                    maxDurationInSeconds: body.options?.maxDuration
                      ? clampMaxDuration(body.options.maxDuration)
                      : undefined,
                    machine: body.options?.machine,
                    priorityMs: body.options?.priority ? body.options.priority * 1_000 : undefined,
                    releaseConcurrency: body.options?.releaseConcurrency,
                    queueTimestamp:
                      parentRun && body.options?.resumeParentOnCompletion
                        ? parentRun.queueTimestamp ?? undefined
                        : undefined,
                  },
                  this._prisma
                );

                const error = taskRun.error ? TaskRunError.parse(taskRun.error) : undefined;

                if (error) {
                  event.failWithError(error);
                }

                return { run: taskRun, error, isCached: false };
              },
              async (_, tx) => {
                const counter = await tx.taskRunNumberCounter.findFirst({
                  where: {
                    taskIdentifier: taskId,
                    environmentId: environment.id,
                  },
                  select: { lastNumber: true },
                });

                return counter?.lastNumber;
              },
              this._prisma
            );

            if (result?.error) {
              throw new ServiceValidationError(
                taskRunErrorToString(taskRunErrorEnhancer(result.error))
              );
            }

            return result;
          }
        );
      } catch (error) {
        if (error instanceof RunDuplicateIdempotencyKeyError) {
          //retry calling this function, because this time it will return the idempotent run
          return await this.call({ taskId, environment, body, options, attempt: attempt + 1 });
        }

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

  async #getMasterQueueForEnvironment(environment: AuthenticatedEnvironment) {
    if (environment.type === "DEVELOPMENT") {
      return;
    }

    const workerGroupService = new WorkerGroupService({
      prisma: this._prisma,
      engine: this._engine,
    });

    const workerGroup = await workerGroupService.getDefaultWorkerGroupForProject({
      projectId: environment.projectId,
    });

    if (!workerGroup) {
      throw new ServiceValidationError("No worker group found");
    }

    return workerGroup.masterQueue;
  }

  // Gets the queue name when the task is NOT locked to a specific version
  async #getQueueName(taskId: string, environment: AuthenticatedEnvironment, queueName?: string) {
    if (queueName) {
      return queueName;
    }

    const defaultQueueName = `task/${taskId}`;

    // Find the current worker for the environment
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
      include: {
        queue: true,
      },
    });

    if (!task) {
      console.log("Failed to get queue name: No task found", {
        taskId,
        environmentId: environment.id,
      });

      return defaultQueueName;
    }

    if (!task.queue) {
      console.log("Failed to get queue name: No queue found", {
        taskId,
        environmentId: environment.id,
        queueConfig: task.queueConfig,
      });

      return defaultQueueName;
    }

    return task.queue.name ?? defaultQueueName;
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

function getMaximumSizeForEnvironment(environment: AuthenticatedEnvironment): number | undefined {
  if (environment.type === "DEVELOPMENT") {
    return environment.organization.maximumDevQueueSize ?? env.MAXIMUM_DEV_QUEUE_SIZE;
  } else {
    return environment.organization.maximumDeployedQueueSize ?? env.MAXIMUM_DEPLOYED_QUEUE_SIZE;
  }
}

export async function guardQueueSizeLimitsForEnv(
  engine: RunEngine,
  environment: AuthenticatedEnvironment,
  itemsToAdd: number = 1
) {
  const maximumSize = getMaximumSizeForEnvironment(environment);

  if (typeof maximumSize === "undefined") {
    return { isWithinLimits: true };
  }

  const queueSize = await engine.lengthOfEnvQueue(environment);
  const projectedSize = queueSize + itemsToAdd;

  return {
    isWithinLimits: projectedSize <= maximumSize,
    maximumSize,
    queueSize,
  };
}
