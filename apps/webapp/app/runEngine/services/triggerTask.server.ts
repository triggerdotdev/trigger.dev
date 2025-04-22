import { RunDuplicateIdempotencyKeyError, RunEngine } from "@internal/run-engine";
import {
  SemanticInternalAttributes,
  TaskRunError,
  taskRunErrorEnhancer,
  taskRunErrorToString,
  TriggerTaskRequestBody,
} from "@trigger.dev/core/v3";
import { BatchId, RunId, stringifyDuration } from "@trigger.dev/core/v3/isomorphic";
import { Prisma, PrismaClientOrTransaction } from "@trigger.dev/database";
import { createTags } from "~/models/taskRunTag.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { autoIncrementCounter } from "~/services/autoIncrementCounter.server";
import { logger } from "~/services/logger.server";
import { parseDelay } from "~/utils/delays";
import { handleMetadataPacket } from "~/utils/packets";
import { eventRepository } from "../../v3/eventRepository.server";
import { ServiceValidationError, WithRunEngine } from "../../v3/services/baseService.server";
import {
  TriggerTaskServiceOptions,
  TriggerTaskServiceResult,
} from "../../v3/services/triggerTask.server";
import { getTaskEventStore } from "../../v3/taskEventStore.server";
import { clampMaxDuration } from "../../v3/utils/maxDuration";
import { IdempotencyKeyConcern } from "../concerns/idempotencyKeys.server";
import { DefaultPayloadProcessor } from "../concerns/payloads.server";
import { DefaultQueueManager } from "../concerns/queues.server";
import { PayloadProcessor, QueueManager, TriggerTaskRequest } from "../types";
import {
  DefaultTriggerTaskValidator,
  TriggerTaskValidator,
} from "../validators/triggerTaskValidator";

export class RunEngineTriggerTaskService extends WithRunEngine {
  private readonly queueConcern: QueueManager;
  private readonly validator: TriggerTaskValidator;
  private readonly payloadProcessor: PayloadProcessor;
  private readonly idempotencyKeyConcern: IdempotencyKeyConcern;

  constructor(
    opts: { prisma?: PrismaClientOrTransaction; engine?: RunEngine } = {},
    queueConcern?: QueueManager,
    validator?: TriggerTaskValidator,
    payloadProcessor?: PayloadProcessor,
    idempotencyKeyConcern?: IdempotencyKeyConcern
  ) {
    super(opts);

    this.queueConcern = queueConcern ?? new DefaultQueueManager(this._prisma, this._engine);
    this.validator = validator ?? new DefaultTriggerTaskValidator();
    this.payloadProcessor = payloadProcessor ?? new DefaultPayloadProcessor();
    this.idempotencyKeyConcern =
      idempotencyKeyConcern ?? new IdempotencyKeyConcern(this._prisma, this._engine);
  }

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

      const runFriendlyId = options?.runFriendlyId ?? RunId.generate().friendlyId;
      const triggerRequest = {
        taskId,
        friendlyId: runFriendlyId,
        environment,
        body,
        options,
      } satisfies TriggerTaskRequest;

      // Validate max attempts
      const maxAttemptsValidation = this.validator.validateMaxAttempts({
        taskId,
        attempt,
      });

      if (!maxAttemptsValidation.ok) {
        throw maxAttemptsValidation.error;
      }

      // Validate tags
      const tagValidation = this.validator.validateTags({
        tags: body.options?.tags,
      });

      if (!tagValidation.ok) {
        throw tagValidation.error;
      }

      // Validate entitlement
      const entitlementValidation = await this.validator.validateEntitlement({
        environment,
      });

      if (!entitlementValidation.ok) {
        throw entitlementValidation.error;
      }

      const delayUntil = await parseDelay(body.options?.delay);

      const ttl =
        typeof body.options?.ttl === "number"
          ? stringifyDuration(body.options?.ttl)
          : body.options?.ttl ?? (environment.type === "DEVELOPMENT" ? "10m" : undefined);

      // Get parent run if specified
      const parentRun = body.options?.parentRunId
        ? await this._prisma.taskRun.findFirst({
            where: {
              id: RunId.fromFriendlyId(body.options.parentRunId),
              runtimeEnvironmentId: environment.id,
            },
          })
        : undefined;

      // Validate parent run
      const parentRunValidation = this.validator.validateParentRun({
        taskId,
        parentRun: parentRun ?? undefined,
        resumeParentOnCompletion: body.options?.resumeParentOnCompletion,
      });

      if (!parentRunValidation.ok) {
        throw parentRunValidation.error;
      }

      const idempotencyKeyConcernResult = await this.idempotencyKeyConcern.handleTriggerRequest(
        triggerRequest
      );

      if (idempotencyKeyConcernResult.isCached) {
        return idempotencyKeyConcernResult;
      }

      const { idempotencyKey, idempotencyKeyExpiresAt } = idempotencyKeyConcernResult;

      if (!options.skipChecks) {
        const queueSizeGuard = await this.queueConcern.validateQueueLimits(environment);

        logger.debug("Queue size guard result", {
          queueSizeGuard,
          environment: {
            id: environment.id,
            type: environment.type,
            organization: environment.organization,
            project: environment.project,
          },
        });

        if (!queueSizeGuard.ok) {
          throw new ServiceValidationError(
            `Cannot trigger ${taskId} as the queue size limit for this environment has been reached. The maximum size is ${queueSizeGuard.maximumSize}`
          );
        }
      }

      const payloadPacket = await this.payloadProcessor.process(triggerRequest);

      const metadataPacket = body.options?.metadata
        ? handleMetadataPacket(
            body.options?.metadata,
            body.options?.metadataType ?? "application/json"
          )
        : undefined;

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

      const { queueName, lockedQueueId } = await this.queueConcern.resolveQueueProperties(
        triggerRequest,
        lockedToBackgroundWorker ?? undefined
      );

      //upsert tags
      const tags = await createTags(
        {
          tags: body.options?.tags,
          projectId: environment.projectId,
        },
        this._prisma
      );

      const depth = parentRun ? parentRun.depth + 1 : 0;

      const masterQueue = await this.queueConcern.getMasterQueue(environment);

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
}
