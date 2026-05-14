import {
  RunDuplicateIdempotencyKeyError,
  RunEngine,
  RunOneTimeUseTokenError,
} from "@internal/run-engine";
import { Tracer } from "@opentelemetry/api";
import { tryCatch } from "@trigger.dev/core/utils";
import {
  RunAnnotations,
  TaskRunError,
  taskRunErrorEnhancer,
  taskRunErrorToString,
  TriggerTaskRequestBody,
  TriggerTraceContext,
} from "@trigger.dev/core/v3";
import {
  parseTraceparent,
  RunId,
  serializeTraceparent,
  stringifyDuration,
} from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { parseDelay } from "~/utils/delays";
import { handleMetadataPacket } from "~/utils/packets";
import { startSpan } from "~/v3/tracing.server";
import type {
  TriggerTaskServiceOptions,
  TriggerTaskServiceResult,
} from "../../v3/services/triggerTask.server";
import { clampMaxDuration } from "../../v3/utils/maxDuration";
import { IdempotencyKeyConcern } from "../concerns/idempotencyKeys.server";
import type {
  PayloadProcessor,
  QueueManager,
  TraceEventConcern,
  TriggerRacepoints,
  TriggerRacepointSystem,
  TriggerTaskRequest,
  TriggerTaskValidator,
} from "../types";
import {
  evaluateGate as defaultEvaluateGate,
  type MollifierEvaluateGate,
} from "~/v3/mollifier/mollifierGate.server";
import {
  getMollifierBuffer as defaultGetMollifierBuffer,
  type MollifierGetBuffer,
} from "~/v3/mollifier/mollifierBuffer.server";
import { mollifyTrigger } from "~/v3/mollifier/mollifierMollify.server";
import { type MollifierBuffer } from "@trigger.dev/redis-worker";
import { QueueSizeLimitExceededError, ServiceValidationError } from "~/v3/services/common.server";

class NoopTriggerRacepointSystem implements TriggerRacepointSystem {
  async waitForRacepoint(options: { racepoint: TriggerRacepoints; id: string }): Promise<void> {
    return;
  }
}

export class RunEngineTriggerTaskService {
  private readonly queueConcern: QueueManager;
  private readonly validator: TriggerTaskValidator;
  private readonly payloadProcessor: PayloadProcessor;
  private readonly idempotencyKeyConcern: IdempotencyKeyConcern;
  private readonly prisma: PrismaClientOrTransaction;
  private readonly engine: RunEngine;
  private readonly tracer: Tracer;
  private readonly traceEventConcern: TraceEventConcern;
  private readonly triggerRacepointSystem: TriggerRacepointSystem;
  private readonly metadataMaximumSize: number;
  // Mollifier hooks are DI'd so tests can drive the call-site's mollify branch
  // deterministically (stub the gate to return mollify, inject a real or fake
  // buffer). In production both default to the live module-level singletons.
  private readonly evaluateGate: MollifierEvaluateGate;
  private readonly getMollifierBuffer: MollifierGetBuffer;

  constructor(opts: {
    prisma: PrismaClientOrTransaction;
    engine: RunEngine;
    queueConcern: QueueManager;
    validator: TriggerTaskValidator;
    payloadProcessor: PayloadProcessor;
    idempotencyKeyConcern: IdempotencyKeyConcern;
    traceEventConcern: TraceEventConcern;
    tracer: Tracer;
    metadataMaximumSize: number;
    triggerRacepointSystem?: TriggerRacepointSystem;
    evaluateGate?: MollifierEvaluateGate;
    getMollifierBuffer?: MollifierGetBuffer;
  }) {
    this.prisma = opts.prisma;
    this.engine = opts.engine;
    this.queueConcern = opts.queueConcern;
    this.validator = opts.validator;
    this.payloadProcessor = opts.payloadProcessor;
    this.idempotencyKeyConcern = opts.idempotencyKeyConcern;
    this.tracer = opts.tracer;
    this.traceEventConcern = opts.traceEventConcern;
    this.metadataMaximumSize = opts.metadataMaximumSize;
    this.triggerRacepointSystem = opts.triggerRacepointSystem ?? new NoopTriggerRacepointSystem();
    this.evaluateGate = opts.evaluateGate ?? defaultEvaluateGate;
    this.getMollifierBuffer = opts.getMollifierBuffer ?? defaultGetMollifierBuffer;
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

      // Validate entitlement (unless skipChecks is enabled)
      let planType: string | undefined;

      if (!options.skipChecks) {
        const entitlementValidation = await this.validator.validateEntitlement({
          environment,
        });

        if (!entitlementValidation.ok) {
          throw entitlementValidation.error;
        }

        // Extract plan type from entitlement response
        planType = entitlementValidation.plan?.type;
      } else {
        // When skipChecks is enabled, planType should be passed via options
        planType = options.planType;

        if (!planType) {
          logger.warn("Plan type not set but skipChecks is enabled", {
            taskId,
            environment: {
              id: environment.id,
              type: environment.type,
              projectId: environment.projectId,
              organizationId: environment.organizationId,
            },
          });
        }
      }

      // Parse delay from either explicit delay option or debounce.delay
      const delaySource = body.options?.delay ?? body.options?.debounce?.delay;
      const [parseDelayError, delayUntil] = await tryCatch(parseDelay(delaySource));

      if (parseDelayError) {
        throw new ServiceValidationError(`Invalid delay ${delaySource}`);
      }

      // Validate debounce options
      if (body.options?.debounce) {
        if (!delayUntil) {
          throw new ServiceValidationError(
            `Debounce requires a valid delay duration. Provided: ${body.options.debounce.delay}`
          );
        }

        // Always validate debounce.delay separately since it's used for rescheduling
        // This catches the case where options.delay is valid but debounce.delay is invalid
        const [debounceDelayError, debounceDelayUntil] = await tryCatch(
          parseDelay(body.options.debounce.delay)
        );

        if (debounceDelayError || !debounceDelayUntil) {
          throw new ServiceValidationError(
            `Invalid debounce delay: ${body.options.debounce.delay}. ` +
            `Supported formats: {number}s, {number}m, {number}h, {number}d, {number}w`
          );
        }
      }

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
        triggerRequest,
        parentRun?.taskEventStore
      );

      if (idempotencyKeyConcernResult.isCached) {
        return idempotencyKeyConcernResult;
      }

      const { idempotencyKey, idempotencyKeyExpiresAt } = idempotencyKeyConcernResult;

      if (idempotencyKey) {
        await this.triggerRacepointSystem.waitForRacepoint({
          racepoint: "idempotencyKey",
          id: idempotencyKey,
        });
      }

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

      const { queueName, lockedQueueId, taskTtl, taskKind } =
        await this.queueConcern.resolveQueueProperties(
          triggerRequest,
          lockedToBackgroundWorker ?? undefined
        );

      // Resolve TTL with precedence: per-trigger > task-level > dev default
      let ttl: string | undefined;

      if (body.options?.ttl !== undefined) {
        ttl =
          typeof body.options.ttl === "number"
            ? stringifyDuration(body.options.ttl)
            : body.options.ttl;
      } else {
        ttl = taskTtl ?? (environment.type === "DEVELOPMENT" ? "10m" : undefined);
      }

      if (!options.skipChecks) {
        const queueSizeGuard = await this.queueConcern.validateQueueLimits(
          environment,
          queueName
        );

        if (!queueSizeGuard.ok) {
          throw new QueueSizeLimitExceededError(
            `Cannot trigger ${taskId} as the queue size limit for this environment has been reached. The maximum size is ${queueSizeGuard.maximumSize}`,
            queueSizeGuard.maximumSize ?? 0,
            undefined,
            "warn"
          );
        }
      }

      const metadataPacket = body.options?.metadata
        ? handleMetadataPacket(
          body.options?.metadata,
          body.options?.metadataType ?? "application/json",
          this.metadataMaximumSize
        )
        : undefined;

      const tags = (
        body.options?.tags
          ? typeof body.options.tags === "string"
            ? [body.options.tags]
            : body.options.tags
          : []
      ).filter((tag) => tag.trim().length > 0);

      const depth = parentRun ? parentRun.depth + 1 : 0;

      const workerQueueResult = await this.queueConcern.getWorkerQueue(
        environment,
        body.options?.region
      );
      const workerQueue = workerQueueResult?.masterQueue;
      const enableFastPath = workerQueueResult?.enableFastPath ?? false;

      // Build annotations for this run
      const triggerSource = options.triggerSource ?? "api";
      const triggerAction = options.triggerAction ?? "trigger";
      const parentAnnotations = RunAnnotations.safeParse(parentRun?.annotations).data;
      const annotations = {
        triggerSource,
        triggerAction,
        rootTriggerSource: parentAnnotations?.rootTriggerSource ?? triggerSource,
        rootScheduleId: parentAnnotations?.rootScheduleId || options.scheduleId || undefined,
        taskKind: taskKind ?? "STANDARD",
      };

      const mollifierOutcome = await this.evaluateGate({
        envId: environment.id,
        orgId: environment.organizationId,
        taskId,
        orgFeatureFlags:
          (environment.organization.featureFlags as Record<string, unknown> | null) ?? null,
        options: {
          debounce: body.options?.debounce,
          oneTimeUseToken: options.oneTimeUseToken,
          parentTaskRunId: body.options?.parentRunId,
          resumeParentOnCompletion: body.options?.resumeParentOnCompletion,
        },
      });

      // Phase 2: real divert path. When the gate says mollify, write the
      // engine.trigger input snapshot into the Redis buffer and return a
      // synthesised TriggerTaskServiceResult. The customer never waits on
      // Postgres; the drainer materialises the run later by replaying
      // engine.trigger against the snapshot. Skip traceRun entirely — the
      // run span is created by the drainer when it eventually runs.
      if (mollifierOutcome.action === "mollify") {
        const mollifierBuffer = this.getMollifierBuffer();
        if (mollifierBuffer && !body.options?.debounce) {
          const synthetic = await startSpan(
            this.tracer,
            "mollifier.queued",
            async (mollifierSpan) => {
              mollifierSpan.setAttribute("mollifier.reason", mollifierOutcome.decision.reason);
              mollifierSpan.setAttribute("mollifier.count", mollifierOutcome.decision.count);
              mollifierSpan.setAttribute(
                "mollifier.threshold",
                mollifierOutcome.decision.threshold
              );
              mollifierSpan.setAttribute("runId", runFriendlyId);

              const payloadPacket = await this.payloadProcessor.process(triggerRequest);
              const taskEventStore = parentRun?.taskEventStore ?? "taskEvent";
              const traceContext = this.#propagateExternalTraceContext(
                {},
                parentRun?.traceContext,
                undefined
              );

              const engineTriggerInput = this.#buildEngineTriggerInput({
                runFriendlyId,
                environment,
                idempotencyKey,
                idempotencyKeyExpiresAt,
                body,
                options,
                queueName,
                lockedQueueId,
                workerQueue,
                enableFastPath,
                lockedToBackgroundWorker: lockedToBackgroundWorker ?? undefined,
                delayUntil,
                ttl,
                metadataPacket,
                tags,
                depth,
                parentRun: parentRun ?? undefined,
                annotations,
                planType,
                taskId,
                payloadPacket,
                traceContext,
                traceId: mollifierSpan.spanContext().traceId,
                spanId: mollifierSpan.spanContext().spanId,
                parentSpanId: undefined,
                taskEventStore,
              });

              const result = await mollifyTrigger({
                runFriendlyId,
                environmentId: environment.id,
                organizationId: environment.organizationId,
                engineTriggerInput,
                decision: mollifierOutcome.decision,
                buffer: mollifierBuffer,
              });

              logger.info("mollifier.buffered", {
                runId: runFriendlyId,
                envId: environment.id,
                orgId: environment.organizationId,
                taskId,
                reason: mollifierOutcome.decision.reason,
              });

              return result;
            }
          );
          // Synthetic result is structurally narrower than the full TaskRun;
          // the route handler only reads `result.run.friendlyId`.
          return synthetic as unknown as TriggerTaskServiceResult;
        }
        if (!mollifierBuffer) {
          logger.warn(
            "mollifier gate said mollify but buffer is null — falling through to pass-through"
          );
        }
      }

      try {
        return await this.traceEventConcern.traceRun(
          triggerRequest,
          parentRun?.taskEventStore,
          async (event, store) => {
            event.setAttribute("queueName", queueName);
            span.setAttribute("queueName", queueName);
            event.setAttribute("runId", runFriendlyId);
            span.setAttribute("runId", runFriendlyId);

            const payloadPacket = await this.payloadProcessor.process(triggerRequest);

            const baseEngineInput = this.#buildEngineTriggerInput({
              runFriendlyId,
              environment,
              idempotencyKey,
              idempotencyKeyExpiresAt,
              body,
              options,
              queueName,
              lockedQueueId,
              workerQueue,
              enableFastPath,
              lockedToBackgroundWorker: lockedToBackgroundWorker ?? undefined,
              delayUntil,
              ttl,
              metadataPacket,
              tags,
              depth,
              parentRun: parentRun ?? undefined,
              annotations,
              planType,
              taskId,
              payloadPacket,
              traceContext: this.#propagateExternalTraceContext(
                event.traceContext,
                parentRun?.traceContext,
                event.traceparent?.spanId
              ),
              traceId: event.traceId,
              spanId: event.spanId,
              parentSpanId:
                options.parentAsLinkType === "replay" ? undefined : event.traceparent?.spanId,
              taskEventStore: store,
            });

            const taskRun = await this.engine.trigger(
              {
                ...baseEngineInput,
                // onDebounced is a closure over webapp state (triggerRequest +
                // traceEventConcern) and can't be serialised into the mollifier
                // snapshot. The pass-through path attaches it here; the drainer
                // path replays without it. C1/F4 gate bypasses ensure debounce
                // and triggerAndWait never reach the mollify branch.
                onDebounced:
                  body.options?.debounce && body.options?.resumeParentOnCompletion
                    ? async ({ existingRun, waitpoint, debounceKey }) => {
                      return await this.traceEventConcern.traceDebouncedRun(
                        triggerRequest,
                        parentRun?.taskEventStore,
                        {
                          existingRun,
                          debounceKey,
                          incomplete: waitpoint.status === "PENDING",
                          isError: waitpoint.outputIsError,
                        },
                        async (spanEvent) => {
                          const spanId =
                            options?.parentAsLinkType === "replay"
                              ? spanEvent.spanId
                              : spanEvent.traceparent?.spanId
                                ? `${spanEvent.traceparent.spanId}:${spanEvent.spanId}`
                                : spanEvent.spanId;
                          return spanId;
                        }
                      );
                    }
                    : undefined,
              },
              this.prisma
            );

            // If the returned run has a different friendlyId, it was debounced.
            // For triggerAndWait: stop the outer span since a replacement debounced span was created via onDebounced.
            // For regular trigger: let the span complete normally - no replacement span needed since the
            // original run already has its span from when it was first created.
            if (
              taskRun.friendlyId !== runFriendlyId &&
              body.options?.debounce &&
              body.options?.resumeParentOnCompletion
            ) {
              event.stop();
            }

            const error = taskRun.error ? TaskRunError.parse(taskRun.error) : undefined;

            if (error) {
              event.failWithError(error);
            }

            const result = { run: taskRun, error, isCached: false };

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
          return await this.call({
            taskId,
            environment,
            body,
            options: { ...options, runFriendlyId },
            attempt: attempt + 1,
          });
        }

        if (error instanceof RunOneTimeUseTokenError) {
          throw new ServiceValidationError(
            `Cannot trigger ${taskId} with a one-time use token as it has already been used.`
          );
        }

        throw error;
      }
    });
  }

  // Build the engine.trigger() input object from the values gathered during
  // this.call(). Extracted so the mollify path (Phase 2) can construct the
  // same input shape without re-entering the trace-run span. The pass-through
  // path spreads this result and attaches `onDebounced` inline; the mollify
  // path serialises it into the buffer for drainer replay.
  #buildEngineTriggerInput(args: {
    runFriendlyId: string;
    environment: AuthenticatedEnvironment;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
    body: TriggerTaskRequest["body"];
    options: TriggerTaskServiceOptions;
    queueName: string;
    lockedQueueId?: string;
    workerQueue?: string;
    enableFastPath: boolean;
    lockedToBackgroundWorker?: { id: string; version: string; sdkVersion: string; cliVersion: string };
    delayUntil?: Date;
    ttl?: string;
    metadataPacket?: { data?: string; dataType: string };
    tags: string[];
    depth: number;
    parentRun?: { id: string; rootTaskRunId?: string | null; queueTimestamp?: Date | null; taskEventStore?: string };
    annotations: {
      triggerSource: string;
      triggerAction: string;
      rootTriggerSource: string;
      rootScheduleId?: string | undefined;
    };
    planType?: string;
    taskId: string;
    payloadPacket: { data?: string; dataType: string };
    traceContext: TriggerTraceContext;
    traceId: string;
    spanId: string;
    parentSpanId: string | undefined;
    taskEventStore: string;
  }) {
    return {
      friendlyId: args.runFriendlyId,
      environment: args.environment,
      idempotencyKey: args.idempotencyKey,
      idempotencyKeyExpiresAt: args.idempotencyKey ? args.idempotencyKeyExpiresAt : undefined,
      idempotencyKeyOptions: args.body.options?.idempotencyKeyOptions,
      taskIdentifier: args.taskId,
      payload: args.payloadPacket.data ?? "",
      payloadType: args.payloadPacket.dataType,
      context: args.body.context,
      traceContext: args.traceContext,
      traceId: args.traceId,
      spanId: args.spanId,
      parentSpanId: args.parentSpanId,
      replayedFromTaskRunFriendlyId: args.options.replayedFromTaskRunFriendlyId,
      lockedToVersionId: args.lockedToBackgroundWorker?.id,
      taskVersion: args.lockedToBackgroundWorker?.version,
      sdkVersion: args.lockedToBackgroundWorker?.sdkVersion,
      cliVersion: args.lockedToBackgroundWorker?.cliVersion,
      concurrencyKey: args.body.options?.concurrencyKey,
      queue: args.queueName,
      lockedQueueId: args.lockedQueueId,
      workerQueue: args.workerQueue,
      enableFastPath: args.enableFastPath,
      isTest: args.body.options?.test ?? false,
      delayUntil: args.delayUntil,
      queuedAt: args.delayUntil ? undefined : new Date(),
      maxAttempts: args.body.options?.maxAttempts,
      taskEventStore: args.taskEventStore,
      ttl: args.ttl,
      tags: args.tags,
      oneTimeUseToken: args.options.oneTimeUseToken,
      parentTaskRunId: args.parentRun?.id,
      rootTaskRunId: args.parentRun?.rootTaskRunId ?? args.parentRun?.id,
      batch: args.options?.batchId
        ? { id: args.options.batchId, index: args.options.batchIndex ?? 0 }
        : undefined,
      resumeParentOnCompletion: args.body.options?.resumeParentOnCompletion,
      depth: args.depth,
      metadata: args.metadataPacket?.data,
      metadataType: args.metadataPacket?.dataType,
      seedMetadata: args.metadataPacket?.data,
      seedMetadataType: args.metadataPacket?.dataType,
      maxDurationInSeconds: args.body.options?.maxDuration
        ? clampMaxDuration(args.body.options.maxDuration)
        : undefined,
      machine: args.body.options?.machine,
      priorityMs: args.body.options?.priority ? args.body.options.priority * 1_000 : undefined,
      queueTimestamp:
        args.options.queueTimestamp ??
        (args.parentRun && args.body.options?.resumeParentOnCompletion
          ? args.parentRun.queueTimestamp ?? undefined
          : undefined),
      scheduleId: args.options.scheduleId,
      scheduleInstanceId: args.options.scheduleInstanceId,
      createdAt: args.options.overrideCreatedAt,
      bulkActionId: args.body.options?.bulkActionId,
      planType: args.planType,
      realtimeStreamsVersion: args.options.realtimeStreamsVersion,
      streamBasinName: args.environment.organization.streamBasinName,
      debounce: args.body.options?.debounce,
      annotations: args.annotations,
    };
  }

  #propagateExternalTraceContext(
    traceContext: Record<string, unknown>,
    parentRunTraceContext: unknown,
    parentSpanId: string | undefined
  ): TriggerTraceContext {
    if (!parentRunTraceContext) {
      return traceContext;
    }

    const parsedParentRunTraceContext = TriggerTraceContext.safeParse(parentRunTraceContext);

    if (!parsedParentRunTraceContext.success) {
      return traceContext;
    }

    const { external } = parsedParentRunTraceContext.data;

    if (!external) {
      return traceContext;
    }

    if (!external.traceparent) {
      return traceContext;
    }

    const parsedTraceparent = parseTraceparent(external.traceparent);

    if (!parsedTraceparent) {
      return traceContext;
    }

    const newExternalTraceparent = serializeTraceparent(
      parsedTraceparent.traceId,
      parentSpanId ?? parsedTraceparent.spanId,
      parsedTraceparent.traceFlags
    );

    return {
      ...traceContext,
      external: {
        ...external,
        traceparent: newExternalTraceparent,
      },
    };
  }
}
