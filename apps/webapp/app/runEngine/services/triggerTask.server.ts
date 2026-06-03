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
import {
  IdempotencyKeyConcern,
  type ClaimedIdempotency,
} from "../concerns/idempotencyKeys.server";
import {
  publishClaim as publishMollifierClaim,
  releaseClaim as releaseMollifierClaim,
} from "~/v3/mollifier/idempotencyClaim.server";
import type {
  PayloadProcessor,
  QueueManager,
  TraceEventConcern,
  TriggerRacepoints,
  TriggerRacepointSystem,
  TriggerTaskRequest,
  TriggerTaskValidator,
} from "../types";
import { env } from "~/env.server";
import {
  evaluateGate as defaultEvaluateGate,
  type GateOutcome,
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
  // buffer, force the global-enabled predicate to true so the call site
  // doesn't short-circuit on an unset env). In production all three default
  // to the live module-level singletons + env read.
  private readonly evaluateGate: MollifierEvaluateGate;
  private readonly getMollifierBuffer: MollifierGetBuffer;
  private readonly isMollifierGloballyEnabled: () => boolean;

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
    isMollifierGloballyEnabled?: () => boolean;
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
    this.isMollifierGloballyEnabled =
      opts.isMollifierGloballyEnabled ?? (() => env.TRIGGER_MOLLIFIER_ENABLED === "1");
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
    // Pre-gate idempotency-claim ownership. Set inside the span when
    // `IdempotencyKeyConcern.handleTriggerRequest` returns `claim:
    // {...}`. The try/catch below resolves it once the span finishes.
    let idempotencyClaim: ClaimedIdempotency | undefined;
    try {
      const result = await startSpan(
        this.tracer,
        "RunEngineTriggerTaskService.call()",
        async (span) => {
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

          const { idempotencyKey, idempotencyKeyExpiresAt, claim: claimResult } =
            idempotencyKeyConcernResult;

          // If we own an idempotency claim, the trigger pipeline below MUST
          // resolve it — publish on success so waiters see our runId,
          // release on error so the next claimant can retry. Stored in an
          // outer scope so the try/catch at the bottom of `callV2` can act
          // on whichever return path or throw the pipeline takes.
          idempotencyClaim = claimResult;

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

          try {
            return await this.traceEventConcern.traceRun(
              triggerRequest,
              parentRun?.taskEventStore,
              async (event, store) => {
                event.setAttribute("queueName", queueName);
                span.setAttribute("queueName", queueName);
                event.setAttribute("runId", runFriendlyId);
                span.setAttribute("runId", runFriendlyId);

                // Short-circuit when mollifier is globally off (the default
                // for every deployment that hasn't opted in). Avoids the
                // GateInputs allocation, the deps spread inside `evaluateGate`,
                // and the `mollifier.decisions{outcome=pass_through}` OTel
                // increment on every trigger — `triggerTask` is the
                // highest-throughput code path in the system. The check goes
                // through a DI'd predicate so unit tests that inject a custom
                // `evaluateGate` can also override the gate-on check (the
                // default reads `env.TRIGGER_MOLLIFIER_ENABLED`, which is "0"
                // in CI where no .env file is present).
                //
                // Batch items bypass the mollifier gate entirely.
                //
                // The mollify path returns a stripped run-shape `{ id,
                // friendlyId, spanId }` with no PG row written. Batch
                // tracking relies on `BatchTaskRunItem`, a join row whose
                // `taskRunId` column has a NOT NULL FK to `TaskRun.id` —
                // creating that join at trigger-time (in
                // `batchTriggerV3.server.ts:871`) fails with FK violation
                // for any mollified item, and skipping it at trigger-time
                // would silently drop the batch↔run link forever because
                // the drainer's materialise path doesn't (yet) create
                // `BatchTaskRunItem`. Either side alone is wrong:
                //   - skip at trigger-time only → batch progress
                //     under-reports forever, `batchTriggerAndWait` parent
                //     stays parked
                //   - mollify at trigger-time only → FK violation, 500
                //
                // The proper end state is a drainer-side
                // `BatchTaskRunItem` create-on-materialise (the snapshot
                // already carries `batch: { id, index }` so the drainer
                // has the info). That belongs in the drainer / replay PR,
                // not here. Until that lands, batch triggers pass-through
                // — they lose the burst-protection benefit, but the path
                // works end-to-end.
                const skipMollifierForBatch = !!options.batchId;
                const mollifierOutcome: GateOutcome | null =
                  this.isMollifierGloballyEnabled() && !skipMollifierForBatch
                    ? await this.evaluateGate({
                        envId: environment.id,
                        orgId: environment.organizationId,
                        taskId,
                        orgFeatureFlags:
                          (environment.organization.featureFlags as Record<string, unknown> | null) ??
                          null,
                        options: {
                          debounce: body.options?.debounce,
                          oneTimeUseToken: options.oneTimeUseToken,
                          parentTaskRunId: body.options?.parentRunId,
                          resumeParentOnCompletion: body.options?.resumeParentOnCompletion,
                        },
                      })
                    : null;

                // When the gate says mollify, write the engine.trigger input
                // snapshot into the Redis buffer and return a synthesised
                // TriggerTaskServiceResult. The customer never waits on
                // Postgres; the drainer materialises the run later by replaying
                // engine.trigger against the snapshot. The run span has already
                // been opened by traceRun above (PARTIAL event in ClickHouse),
                // so its traceId/spanId live in the snapshot and the drainer's
                // `mollifier.drained` span parents on the same trace — buffered
                // runs become visible in the dashboard's trace view immediately,
                // not only after the drainer fires.
                if (mollifierOutcome?.action === "mollify") {
                  const mollifierBuffer = this.getMollifierBuffer();
                  if (mollifierBuffer && !body.options?.debounce) {
                    event.setAttribute("mollifier.reason", mollifierOutcome.decision.reason);
                    event.setAttribute("mollifier.count", String(mollifierOutcome.decision.count));
                    event.setAttribute(
                      "mollifier.threshold",
                      String(mollifierOutcome.decision.threshold)
                    );
                    event.setAttribute("taskRunId", runFriendlyId);

                    const payloadPacket = await this.payloadProcessor.process(triggerRequest);

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
                      traceContext: this.#propagateExternalTraceContext(
                        event.traceContext,
                        parentRun?.traceContext,
                        event.traceparent?.spanId
                      ),
                      traceId: event.traceId,
                      spanId: event.spanId,
                      parentSpanId:
                        options.parentAsLinkType === "replay"
                          ? undefined
                          : event.traceparent?.spanId,
                      taskEventStore: store,
                    });

                    const result = await mollifyTrigger({
                      runFriendlyId,
                      environmentId: environment.id,
                      organizationId: environment.organizationId,
                      engineTriggerInput,
                      decision: mollifierOutcome.decision,
                      buffer: mollifierBuffer,
                      // Idempotency-key triple wires the buffer's SETNX into
                      // the trigger-time dedup symmetric with PG.
                      idempotencyKey,
                      taskIdentifier: taskId,
                    });

                    logger.debug("mollifier.buffered", {
                      runId: runFriendlyId,
                      envId: environment.id,
                      orgId: environment.organizationId,
                      taskId,
                      reason: mollifierOutcome.decision.reason,
                    });

                    // Synthetic result is structurally narrower than the full
                    // TaskRun; the route handler only reads
                    // `result.run.friendlyId`. traceRun flushes the PARTIAL
                    // run-span event to ClickHouse on callback return.
                    // `isMollified` flags the route to skip the request-
                    // idempotency cache write — see the field's contract on
                    // `TriggerTaskServiceResult`.
                    return {
                      ...(result as unknown as TriggerTaskServiceResult),
                      isMollified: true,
                    };
                  }
                  if (!mollifierBuffer) {
                    logger.warn(
                      "mollifier gate said mollify but buffer is null — falling through to pass-through"
                    );
                  }
                }

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
                    // path replays without it. The debounce and triggerAndWait gate
                    // bypasses ensure neither reaches the mollify branch.
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
        },
      );
      // Pipeline returned successfully — publish the claim if we held
      // one. Waiters polling for our key resolve to this runId.
      if (idempotencyClaim && result?.run?.friendlyId) {
        await publishMollifierClaim({
          envId: idempotencyClaim.envId,
          taskIdentifier: idempotencyClaim.taskIdentifier,
          idempotencyKey: idempotencyClaim.idempotencyKey,
          token: idempotencyClaim.token,
          runId: result.run.friendlyId,
        });
      }
      return result;
    } catch (err) {
      // Pipeline threw — release the claim so the next claimant can
      // retry. Re-throw so the caller sees the original error.
      if (idempotencyClaim) {
        await releaseMollifierClaim(idempotencyClaim);
      }
      throw err;
    }
  }

  // Build the engine.trigger() input object from the values gathered during
  // this.call(). Extracted so the mollify path can construct the
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
      // Schema-level coercion now lands `body.options.concurrencyKey` as
      // `string` on the API path, but the BatchQueue worker rebuilds
      // body.options from Redis-stored items (Record<string, unknown>),
      // which can still carry the pre-fix shape from in-flight batches.
      concurrencyKey:
        typeof args.body.options?.concurrencyKey === "number"
          ? String(args.body.options.concurrencyKey)
          : args.body.options?.concurrencyKey,
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
