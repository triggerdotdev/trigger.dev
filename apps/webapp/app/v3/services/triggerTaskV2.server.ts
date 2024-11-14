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
import { sanitizeQueueName } from "~/v3/marqs/index.server";
import { eventRepository } from "../eventRepository.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { uploadToObjectStore } from "../r2.server";
import { startActiveSpan } from "../tracer.server";
import { getEntitlement } from "~/services/platform.v3.server";
import { ServiceValidationError, WithRunEngine } from "./baseService.server";
import { logger } from "~/services/logger.server";
import { isFinalAttemptStatus, isFinalRunStatus } from "../taskStatus";
import { createTag, MAX_TAGS_PER_RUN } from "~/models/taskRunTag.server";
import { findCurrentWorkerFromEnvironment } from "../models/workerDeployment.server";
import { handleMetadataPacket } from "~/utils/packets";
import { WorkerGroupService } from "./worker/workerGroupService.server";
import { parseDelay } from "~/utils/delays";
import { stringifyDuration } from "@trigger.dev/core/v3/apps";
import { OutOfEntitlementError, TriggerTaskServiceOptions } from "./triggerTask.server";

/** @deprecated Use TriggerTaskService in `triggerTask.server.ts` instead. */
export class TriggerTaskServiceV2 extends WithRunEngine {
  public async call({
    taskId,
    environment,
    body,
    options = {},
  }: {
    taskId: string;
    environment: AuthenticatedEnvironment;
    body: TriggerTaskRequestBody;
    options?: TriggerTaskServiceOptions;
  }) {
    return await this.traceWithEnv("call()", environment, async (span) => {
      span.setAttribute("taskId", taskId);

      const idempotencyKey = options.idempotencyKey ?? body.options?.idempotencyKey;
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
        span.setAttribute("runId", existingRun.friendlyId);

        //We're using `andWait` so we need to block the parent run with a waitpoint
        if (
          existingRun.associatedWaitpoint?.status === "PENDING" &&
          body.options?.resumeParentOnCompletion &&
          body.options?.parentRunId
        ) {
          await this._engine.blockRunWithWaitpoint({
            runId: body.options.parentRunId,
            waitpointId: existingRun.associatedWaitpoint.id,
            environmentId: environment.id,
            projectId: environment.projectId,
            tx: this._prisma,
          });
        }

        return existingRun;
      }

      if (environment.type !== "DEVELOPMENT") {
        const result = await getEntitlement(environment.organizationId);
        if (result && result.hasAccess === false) {
          throw new OutOfEntitlementError();
        }
      }

      //check the env queue isn't beyond the limit
      const queueSizeGuard = await this.#guardQueueSizeLimitsForEnv(environment);

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

      //todo we will pass in the `parentRun` and `resumeParentOnCompletion`
      const parentRun = body.options?.parentRunId
        ? await this._prisma.taskRun.findFirst({
            where: { id: body.options.parentRunId },
          })
        : undefined;

      if (parentRun && isFinalRunStatus(parentRun.status)) {
        logger.debug("Parent run is in a terminal state", {
          parentRun,
        });

        throw new ServiceValidationError(
          `Cannot trigger ${taskId} as the parent run has a status of ${parentRun.status}`
        );
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

              const depth = parentRun ? parentRun.depth + 1 : 0;

              event.setAttribute("runId", runFriendlyId);
              span.setAttribute("runId", runFriendlyId);

              const workerGroupService = new WorkerGroupService({
                prisma: this._prisma,
                engine: this._engine,
              });
              const workerGroup = await workerGroupService.getDefaultWorkerGroupForProject({
                projectId: environment.projectId,
              });

              if (!workerGroup) {
                logger.error("Default worker group not found", {
                  projectId: environment.projectId,
                });

                return;
              }

              const taskRun = await this._engine.trigger(
                {
                  number: num,
                  friendlyId: runFriendlyId,
                  environment: environment,
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
                  queueName,
                  queue: body.options?.queue,
                  masterQueue: workerGroup.masterQueue,
                  isTest: body.options?.test ?? false,
                  delayUntil,
                  queuedAt: delayUntil ? undefined : new Date(),
                  maxAttempts: body.options?.maxAttempts,
                  ttl,
                  tags: tagIds,
                  parentTaskRunId: parentRun?.id,
                  rootTaskRunId: parentRun?.rootTaskRunId ?? undefined,
                  batchId: body.options?.parentBatch ?? undefined,
                  resumeParentOnCompletion: body.options?.resumeParentOnCompletion,
                  depth,
                  metadata: metadataPacket?.data,
                  metadataType: metadataPacket?.dataType,
                  seedMetadata: metadataPacket?.data,
                  seedMetadataType: metadataPacket?.dataType,
                },
                this._prisma
              );

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

  async #guardQueueSizeLimitsForEnv(environment: AuthenticatedEnvironment) {
    const maximumSize = getMaximumSizeForEnvironment(environment);

    if (typeof maximumSize === "undefined") {
      return { isWithinLimits: true };
    }

    const queueSize = await this._engine.lengthOfEnvQueue(environment);

    return {
      isWithinLimits: queueSize < maximumSize,
      maximumSize,
      queueSize,
    };
  }
}

function getMaximumSizeForEnvironment(environment: AuthenticatedEnvironment): number | undefined {
  if (environment.type === "DEVELOPMENT") {
    return environment.organization.maximumDevQueueSize ?? env.MAXIMUM_DEV_QUEUE_SIZE;
  } else {
    return environment.organization.maximumDeployedQueueSize ?? env.MAXIMUM_DEPLOYED_QUEUE_SIZE;
  }
}
