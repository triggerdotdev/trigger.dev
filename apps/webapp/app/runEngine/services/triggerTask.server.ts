import {
  RunDuplicateIdempotencyKeyError,
  RunEngine,
  RunOneTimeUseTokenError,
} from "@internal/run-engine";
import { Tracer } from "@opentelemetry/api";
import { tryCatch } from "@trigger.dev/core/utils";
import {
  TaskRunError,
  taskRunErrorEnhancer,
  taskRunErrorToString,
  TriggerTaskRequestBody,
} from "@trigger.dev/core/v3";
import { RunId, stringifyDuration } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { createTags } from "~/models/taskRunTag.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { parseDelay } from "~/utils/delays";
import { handleMetadataPacket } from "~/utils/packets";
import { startSpan } from "~/v3/tracing.server";
import type {
  TriggerTaskServiceOptions,
  TriggerTaskServiceResult,
} from "../../v3/services/triggerTask.server";
import { getTaskEventStore } from "../../v3/taskEventStore.server";
import { clampMaxDuration } from "../../v3/utils/maxDuration";
import { EngineServiceValidationError } from "../concerns/errors";
import { IdempotencyKeyConcern } from "../concerns/idempotencyKeys.server";
import type {
  PayloadProcessor,
  QueueManager,
  RunChainStateManager,
  RunNumberIncrementer,
  TraceEventConcern,
  TriggerTaskRequest,
  TriggerTaskValidator,
} from "../types";

export class RunEngineTriggerTaskService {
  private readonly queueConcern: QueueManager;
  private readonly validator: TriggerTaskValidator;
  private readonly payloadProcessor: PayloadProcessor;
  private readonly idempotencyKeyConcern: IdempotencyKeyConcern;
  private readonly runNumberIncrementer: RunNumberIncrementer;
  private readonly prisma: PrismaClientOrTransaction;
  private readonly engine: RunEngine;
  private readonly tracer: Tracer;
  private readonly traceEventConcern: TraceEventConcern;
  private readonly runChainStateManager: RunChainStateManager;

  constructor(opts: {
    prisma: PrismaClientOrTransaction;
    engine: RunEngine;
    queueConcern: QueueManager;
    validator: TriggerTaskValidator;
    payloadProcessor: PayloadProcessor;
    idempotencyKeyConcern: IdempotencyKeyConcern;
    runNumberIncrementer: RunNumberIncrementer;
    traceEventConcern: TraceEventConcern;
    runChainStateManager: RunChainStateManager;
    tracer: Tracer;
  }) {
    this.prisma = opts.prisma;
    this.engine = opts.engine;
    this.queueConcern = opts.queueConcern;
    this.validator = opts.validator;
    this.payloadProcessor = opts.payloadProcessor;
    this.idempotencyKeyConcern = opts.idempotencyKeyConcern;
    this.runNumberIncrementer = opts.runNumberIncrementer;
    this.tracer = opts.tracer;
    this.traceEventConcern = opts.traceEventConcern;
    this.runChainStateManager = opts.runChainStateManager;
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
    return await startSpan(this.tracer, "RunEngineTriggerTaskService.call()", async (span) => {
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

      const [parseDelayError, delayUntil] = await tryCatch(parseDelay(body.options?.delay));

      if (parseDelayError) {
        throw new EngineServiceValidationError(`Invalid delay ${body.options?.delay}`);
      }

      const ttl =
        typeof body.options?.ttl === "number"
          ? stringifyDuration(body.options?.ttl)
          : body.options?.ttl ?? (environment.type === "DEVELOPMENT" ? "10m" : undefined);

      // Get parent run if specified
      const parentRun = body.options?.parentRunId
        ? await this.prisma.taskRun.findFirst({
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
          throw new EngineServiceValidationError(
            `Cannot trigger ${taskId} as the queue size limit for this environment has been reached. The maximum size is ${queueSizeGuard.maximumSize}`
          );
        }
      }

      const metadataPacket = body.options?.metadata
        ? handleMetadataPacket(
            body.options?.metadata,
            body.options?.metadataType ?? "application/json"
          )
        : undefined;

      const lockedToBackgroundWorker = body.options?.lockToVersion
        ? await this.prisma.backgroundWorker.findFirst({
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
        this.prisma
      );

      const depth = parentRun ? parentRun.depth + 1 : 0;

      const runChainState = await this.runChainStateManager.validateRunChain(triggerRequest, {
        parentRun: parentRun ?? undefined,
        queueName,
        lockedQueueId,
      });

      const workerQueue = await this.queueConcern.getWorkerQueue(environment);

      try {
        return await this.traceEventConcern.traceRun(triggerRequest, async (event) => {
          const result = await this.runNumberIncrementer.incrementRunNumber(
            triggerRequest,
            async (num) => {
              event.setAttribute("queueName", queueName);
              span.setAttribute("queueName", queueName);
              event.setAttribute("runId", runFriendlyId);
              span.setAttribute("runId", runFriendlyId);

              const payloadPacket = await this.payloadProcessor.process(triggerRequest);

              const taskRun = await this.engine.trigger(
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
                  traceContext: event.traceContext,
                  traceId: event.traceId,
                  spanId: event.spanId,
                  parentSpanId:
                    options.parentAsLinkType === "replay" ? undefined : event.traceparent?.spanId,
                  lockedToVersionId: lockedToBackgroundWorker?.id,
                  taskVersion: lockedToBackgroundWorker?.version,
                  sdkVersion: lockedToBackgroundWorker?.sdkVersion,
                  cliVersion: lockedToBackgroundWorker?.cliVersion,
                  concurrencyKey: body.options?.concurrencyKey,
                  queue: queueName,
                  lockedQueueId,
                  workerQueue,
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
                    options.queueTimestamp ??
                    (parentRun && body.options?.resumeParentOnCompletion
                      ? parentRun.queueTimestamp ?? undefined
                      : undefined),
                  runChainState,
                  scheduleId: options.scheduleId,
                  scheduleInstanceId: options.scheduleInstanceId,
                },
                this.prisma
              );

              const error = taskRun.error ? TaskRunError.parse(taskRun.error) : undefined;

              if (error) {
                event.failWithError(error);
              }

              return { run: taskRun, error, isCached: false };
            }
          );

          if (result?.error) {
            throw new EngineServiceValidationError(
              taskRunErrorToString(taskRunErrorEnhancer(result.error))
            );
          }

          return result;
        });
      } catch (error) {
        if (error instanceof RunDuplicateIdempotencyKeyError) {
          //retry calling this function, because this time it will return the idempotent run
          return await this.call({ taskId, environment, body, options, attempt: attempt + 1 });
        }

        if (error instanceof RunOneTimeUseTokenError) {
          throw new EngineServiceValidationError(
            `Cannot trigger ${taskId} with a one-time use token as it has already been used.`
          );
        }

        throw error;
      }
    });
  }
}
