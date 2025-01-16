import { Worker } from "@internal/redis-worker";
import { Attributes, Span, SpanKind, trace, Tracer } from "@opentelemetry/api";
import { assertExhaustive } from "@trigger.dev/core";
import { Logger } from "@trigger.dev/core/logger";
import {
  CompleteRunAttemptResult,
  DequeuedMessage,
  ExecutionResult,
  MachineResources,
  parsePacket,
  RunExecutionData,
  sanitizeError,
  shouldRetryError,
  StartRunAttemptResult,
  TaskRunError,
  taskRunErrorEnhancer,
  TaskRunExecution,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  TaskRunInternalError,
  TaskRunSuccessfulExecutionResult,
  WaitForDurationResult,
} from "@trigger.dev/core/v3";
import {
  BatchId,
  getMaxDuration,
  parseNaturalLanguageDuration,
  QueueId,
  RunId,
  sanitizeQueueName,
  SnapshotId,
  WaitpointId,
} from "@trigger.dev/core/v3/apps";
import {
  $transaction,
  Prisma,
  PrismaClient,
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunExecutionSnapshot,
  TaskRunExecutionStatus,
  TaskRunStatus,
  Waitpoint,
} from "@trigger.dev/database";
import assertNever from "assert-never";
import { Redis } from "ioredis";
import { nanoid } from "nanoid";
import { EventEmitter } from "node:events";
import { z } from "zod";
import { RunQueue } from "../run-queue";
import { SimpleWeightedChoiceStrategy } from "../run-queue/simpleWeightedPriorityStrategy";
import { MinimalAuthenticatedEnvironment } from "../shared";
import { MAX_TASK_RUN_ATTEMPTS } from "./consts";
import { getRunWithBackgroundWorkerTasks } from "./db/worker";
import { runStatusFromError } from "./errors";
import { EventBusEvents } from "./eventBus";
import { executionResultFromSnapshot, getLatestExecutionSnapshot } from "./executionSnapshots";
import { RunLocker } from "./locking";
import { getMachinePreset } from "./machinePresets";
import {
  isCheckpointable,
  isDequeueableExecutionStatus,
  isExecuting,
  isFinalRunStatus,
} from "./statuses";
import { HeartbeatTimeouts, RunEngineOptions, TriggerParams } from "./types";

const workerCatalog = {
  finishWaitpoint: {
    schema: z.object({
      waitpointId: z.string(),
      error: z.string().optional(),
    }),
    visibilityTimeoutMs: 5000,
  },
  heartbeatSnapshot: {
    schema: z.object({
      runId: z.string(),
      snapshotId: z.string(),
    }),
    visibilityTimeoutMs: 5000,
  },
  expireRun: {
    schema: z.object({
      runId: z.string(),
    }),
    visibilityTimeoutMs: 5000,
  },
  cancelRun: {
    schema: z.object({
      runId: z.string(),
      completedAt: z.coerce.date(),
      reason: z.string().optional(),
    }),
    visibilityTimeoutMs: 5000,
  },
  queueRunsWaitingForWorker: {
    schema: z.object({
      backgroundWorkerId: z.string(),
    }),
    visibilityTimeoutMs: 5000,
  },
  tryCompleteBatch: {
    schema: z.object({
      batchId: z.string(),
    }),
    visibilityTimeoutMs: 10_000,
  },
  continueRunIfUnblocked: {
    schema: z.object({
      runId: z.string(),
    }),
    visibilityTimeoutMs: 10_000,
  },
};

type EngineWorker = Worker<typeof workerCatalog>;

export class RunEngine {
  private redis: Redis;
  private prisma: PrismaClient;
  private runLock: RunLocker;
  runQueue: RunQueue;
  private worker: EngineWorker;
  private logger = new Logger("RunEngine", "debug");
  private tracer: Tracer;
  private heartbeatTimeouts: HeartbeatTimeouts;
  eventBus = new EventEmitter<EventBusEvents>();

  constructor(private readonly options: RunEngineOptions) {
    this.prisma = options.prisma;
    this.redis = new Redis(options.redis);
    this.runLock = new RunLocker({ redis: this.redis });

    this.runQueue = new RunQueue({
      name: "rq",
      tracer: trace.getTracer("rq"),
      queuePriorityStrategy: new SimpleWeightedChoiceStrategy({ queueSelectionCount: 36 }),
      envQueuePriorityStrategy: new SimpleWeightedChoiceStrategy({ queueSelectionCount: 12 }),
      defaultEnvConcurrency: options.queue?.defaultEnvConcurrency ?? 10,
      logger: new Logger("RunQueue", "warn"),
      redis: options.redis,
      retryOptions: options.queue?.retryOptions,
    });

    this.worker = new Worker({
      name: "runengineworker",
      redisOptions: options.redis,
      catalog: workerCatalog,
      concurrency: options.worker,
      pollIntervalMs: options.worker.pollIntervalMs,
      logger: new Logger("RunEngineWorker", "debug"),
      jobs: {
        finishWaitpoint: async ({ payload }) => {
          await this.completeWaitpoint({
            id: payload.waitpointId,
            output: payload.error
              ? {
                  value: payload.error,
                  isError: true,
                }
              : undefined,
          });
        },
        heartbeatSnapshot: async ({ payload }) => {
          await this.#handleStalledSnapshot(payload);
        },
        expireRun: async ({ payload }) => {
          await this.#expireRun({ runId: payload.runId });
        },
        cancelRun: async ({ payload }) => {
          await this.cancelRun({
            runId: payload.runId,
            completedAt: payload.completedAt,
            reason: payload.reason,
          });
        },
        queueRunsWaitingForWorker: async ({ payload }) => {
          await this.#queueRunsWaitingForWorker({ backgroundWorkerId: payload.backgroundWorkerId });
        },
        tryCompleteBatch: async ({ payload }) => {
          await this.#tryCompleteBatch({ batchId: payload.batchId });
        },
        continueRunIfUnblocked: async ({ payload }) => {
          await this.#continueRunIfUnblocked({
            runId: payload.runId,
          });
        },
      },
    });

    this.tracer = options.tracer;

    const defaultHeartbeatTimeouts: HeartbeatTimeouts = {
      PENDING_EXECUTING: 60_000,
      PENDING_CANCEL: 60_000,
      EXECUTING: 60_000,
      EXECUTING_WITH_WAITPOINTS: 60_000,
    };
    this.heartbeatTimeouts = {
      ...defaultHeartbeatTimeouts,
      ...(options.heartbeatTimeoutsMs ?? {}),
    };
  }

  //MARK: - Run functions

  /** "Triggers" one run. */
  async trigger(
    {
      friendlyId,
      number,
      environment,
      idempotencyKey,
      idempotencyKeyExpiresAt,
      taskIdentifier,
      payload,
      payloadType,
      context,
      traceContext,
      traceId,
      spanId,
      parentSpanId,
      lockedToVersionId,
      taskVersion,
      sdkVersion,
      cliVersion,
      concurrencyKey,
      masterQueue,
      queueName,
      queue,
      isTest,
      delayUntil,
      queuedAt,
      maxAttempts,
      priorityMs,
      ttl,
      tags,
      parentTaskRunId,
      rootTaskRunId,
      batch,
      resumeParentOnCompletion,
      depth,
      metadata,
      metadataType,
      seedMetadata,
      seedMetadataType,
      oneTimeUseToken,
      maxDurationInSeconds,
      machine,
    }: TriggerParams,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    const prisma = tx ?? this.prisma;

    return this.#trace(
      "trigger",
      {
        friendlyId,
        environmentId: environment.id,
        projectId: environment.project.id,
        taskIdentifier,
      },
      async (span) => {
        const status = delayUntil ? "DELAYED" : "PENDING";

        let secondaryMasterQueue = this.#environmentMasterQueueKey(environment.id);
        if (lockedToVersionId) {
          secondaryMasterQueue = this.#backgroundWorkerQueueKey(lockedToVersionId);
        }

        //create run
        let taskRun: TaskRun;
        try {
          taskRun = await prisma.taskRun.create({
            data: {
              id: RunId.fromFriendlyId(friendlyId),
              engine: "V2",
              status,
              number,
              friendlyId,
              runtimeEnvironmentId: environment.id,
              projectId: environment.project.id,
              idempotencyKey,
              idempotencyKeyExpiresAt,
              taskIdentifier,
              payload,
              payloadType,
              context,
              traceContext,
              traceId,
              spanId,
              parentSpanId,
              lockedToVersionId,
              taskVersion,
              sdkVersion,
              cliVersion,
              concurrencyKey,
              queue: queueName,
              masterQueue,
              secondaryMasterQueue,
              isTest,
              delayUntil,
              queuedAt,
              maxAttempts,
              priorityMs,
              ttl,
              tags:
                tags.length === 0
                  ? undefined
                  : {
                      connect: tags,
                    },
              runTags: tags.length === 0 ? undefined : tags.map((tag) => tag.name),
              oneTimeUseToken,
              parentTaskRunId,
              rootTaskRunId,
              batchId: batch?.id,
              resumeParentOnCompletion,
              depth,
              metadata,
              metadataType,
              seedMetadata,
              seedMetadataType,
              maxDurationInSeconds,
              machinePreset: machine,
              executionSnapshots: {
                create: {
                  engine: "V2",
                  executionStatus: "RUN_CREATED",
                  description: "Run was created",
                  runStatus: status,
                },
              },
            },
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError) {
            this.logger.debug("engine.trigger(): Prisma transaction error", {
              code: error.code,
              message: error.message,
              meta: error.meta,
              idempotencyKey,
              environmentId: environment.id,
            });

            if (error.code === "P2002") {
              this.logger.debug("engine.trigger(): throwing RunDuplicateIdempotencyKeyError", {
                code: error.code,
                message: error.message,
                meta: error.meta,
                idempotencyKey,
                environmentId: environment.id,
              });

              //this happens if a unique constraint failed, i.e. duplicate idempotency
              throw new RunDuplicateIdempotencyKeyError(
                `Run with idempotency key ${idempotencyKey} already exists`
              );
            }
          }

          throw error;
        }

        span.setAttribute("runId", taskRun.id);

        await this.runLock.lock([taskRun.id], 5000, async (signal) => {
          //create associated waitpoint (this completes when the run completes)
          const associatedWaitpoint = await this.#createRunAssociatedWaitpoint(prisma, {
            projectId: environment.project.id,
            environmentId: environment.id,
            completedByTaskRunId: taskRun.id,
          });

          //triggerAndWait or batchTriggerAndWait
          if (resumeParentOnCompletion && parentTaskRunId) {
            //this will block the parent run from continuing until this waitpoint is completed (and removed)
            await this.blockRunWithWaitpoint({
              runId: parentTaskRunId,
              waitpoints: associatedWaitpoint.id,
              environmentId: associatedWaitpoint.environmentId,
              projectId: associatedWaitpoint.projectId,
              batch,
              tx: prisma,
            });

            //release the concurrency
            //if the queue is the same then it's recursive and we need to release that too otherwise we could have a deadlock
            const parentRun = await prisma.taskRun.findUnique({
              select: {
                queue: true,
              },
              where: {
                id: parentTaskRunId,
              },
            });
            const releaseRunConcurrency = parentRun?.queue === taskRun.queue;
            await this.runQueue.releaseConcurrency(
              environment.organization.id,
              parentTaskRunId,
              releaseRunConcurrency
            );
          }

          //Make sure lock extension succeeded
          signal.throwIfAborted();

          if (queue) {
            const concurrencyLimit =
              typeof queue.concurrencyLimit === "number"
                ? Math.max(Math.min(queue.concurrencyLimit, environment.maximumConcurrencyLimit), 0)
                : null;

            let taskQueue = await prisma.taskQueue.findFirst({
              where: {
                runtimeEnvironmentId: environment.id,
                name: queueName,
              },
            });

            const existingConcurrencyLimit =
              typeof taskQueue?.concurrencyLimit === "number"
                ? taskQueue.concurrencyLimit
                : undefined;

            if (taskQueue) {
              if (existingConcurrencyLimit !== concurrencyLimit) {
                taskQueue = await prisma.taskQueue.update({
                  where: {
                    id: taskQueue.id,
                  },
                  data: {
                    concurrencyLimit:
                      typeof concurrencyLimit === "number" ? concurrencyLimit : null,
                  },
                });

                if (typeof taskQueue.concurrencyLimit === "number") {
                  await this.runQueue.updateQueueConcurrencyLimits(
                    environment,
                    taskQueue.name,
                    taskQueue.concurrencyLimit
                  );
                } else {
                  await this.runQueue.removeQueueConcurrencyLimits(environment, taskQueue.name);
                }
              }
            } else {
              taskQueue = await prisma.taskQueue.create({
                data: {
                  ...QueueId.generate(),
                  name: queueName,
                  concurrencyLimit,
                  runtimeEnvironmentId: environment.id,
                  projectId: environment.project.id,
                  type: "NAMED",
                },
              });

              if (typeof taskQueue.concurrencyLimit === "number") {
                await this.runQueue.updateQueueConcurrencyLimits(
                  environment,
                  taskQueue.name,
                  taskQueue.concurrencyLimit
                );
              }
            }
          }

          if (taskRun.delayUntil) {
            const delayWaitpoint = await this.#createDateTimeWaitpoint(prisma, {
              projectId: environment.project.id,
              environmentId: environment.id,
              completedAfter: taskRun.delayUntil,
            });

            await prisma.taskRunWaitpoint.create({
              data: {
                taskRunId: taskRun.id,
                waitpointId: delayWaitpoint.id,
                projectId: delayWaitpoint.projectId,
              },
            });
          }

          if (!taskRun.delayUntil && taskRun.ttl) {
            const expireAt = parseNaturalLanguageDuration(taskRun.ttl);

            if (expireAt) {
              await this.worker.enqueue({
                id: `expireRun:${taskRun.id}`,
                job: "expireRun",
                payload: { runId: taskRun.id },
              });
            }
          }

          //Make sure lock extension succeeded
          signal.throwIfAborted();

          //enqueue the run if it's not delayed
          if (!taskRun.delayUntil) {
            await this.#enqueueRun({
              run: taskRun,
              env: environment,
              timestamp: Date.now() - taskRun.priorityMs,
              tx: prisma,
            });
          }
        });

        return taskRun;
      }
    );
  }

  /**
   * Gets a fairly selected run from the specified master queue, returning the information required to run it.
   * @param consumerId: The consumer that is pulling, allows multiple consumers to pull from the same queue
   * @param masterQueue: The shared queue to pull from, can be an individual environment (for dev)
   * @returns
   */
  async dequeueFromMasterQueue({
    consumerId,
    masterQueue,
    maxRunCount,
    maxResources,
    backgroundWorkerId,
    tx,
  }: {
    consumerId: string;
    masterQueue: string;
    maxRunCount: number;
    maxResources?: MachineResources;
    backgroundWorkerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<DequeuedMessage[]> {
    const prisma = tx ?? this.prisma;
    return this.#trace("dequeueFromMasterQueue", { consumerId, masterQueue }, async (span) => {
      //gets multiple runs from the queue
      const messages = await this.runQueue.dequeueMessageFromMasterQueue(
        consumerId,
        masterQueue,
        maxRunCount
      );
      if (messages.length === 0) {
        return [];
      }

      //we can't send more than the max resources
      const consumedResources: MachineResources = {
        cpu: 0,
        memory: 0,
      };

      const dequeuedRuns: DequeuedMessage[] = [];

      for (const message of messages) {
        const orgId = message.message.orgId;
        const runId = message.messageId;

        span.setAttribute("runId", runId);

        //lock the run so nothing else can modify it
        try {
          const dequeuedRun = await this.runLock.lock([runId], 5000, async (signal) => {
            const snapshot = await getLatestExecutionSnapshot(prisma, runId);

            if (!isDequeueableExecutionStatus(snapshot.executionStatus)) {
              //create a failed snapshot
              await this.#createExecutionSnapshot(prisma, {
                run: {
                  id: snapshot.runId,
                  status: snapshot.runStatus,
                },
                snapshot: {
                  executionStatus: snapshot.executionStatus,
                  description:
                    "Tried to dequeue a run that is not in a valid state to be dequeued.",
                },
                checkpointId: snapshot.checkpointId ?? undefined,
                completedWaitpoints: snapshot.completedWaitpoints,
                error: `Tried to dequeue a run that is not in a valid state to be dequeued.`,
              });

              //todo is there a way to recover this, so the run can be retried?
              //for example should we update the status to a dequeuable status and nack it?
              //then at least it has a chance of succeeding and we have the error log above
              await this.#systemFailure({
                runId,
                error: {
                  type: "INTERNAL_ERROR",
                  code: "TASK_DEQUEUED_INVALID_STATE",
                  message: `Task was in the ${snapshot.executionStatus} state when it was dequeued for execution.`,
                },
                tx: prisma,
              });
              this.logger.error(
                `RunEngine.dequeueFromMasterQueue(): Run is not in a valid state to be dequeued: ${runId}\n ${snapshot.id}:${snapshot.executionStatus}`
              );
              return null;
            }

            const result = await getRunWithBackgroundWorkerTasks(prisma, runId, backgroundWorkerId);

            if (!result.success) {
              switch (result.code) {
                case "NO_RUN": {
                  //this should not happen, the run is unrecoverable so we'll ack it
                  this.logger.error("RunEngine.dequeueFromMasterQueue(): No run found", {
                    runId,
                    latestSnapshot: snapshot.id,
                  });
                  await this.runQueue.acknowledgeMessage(orgId, runId);
                  return null;
                }
                case "NO_WORKER":
                case "TASK_NEVER_REGISTERED":
                case "TASK_NOT_IN_LATEST": {
                  this.logger.warn(`RunEngine.dequeueFromMasterQueue(): ${result.code}`, {
                    runId,
                    latestSnapshot: snapshot.id,
                    result,
                  });

                  //not deployed yet, so we'll wait for the deploy
                  await this.#waitingForDeploy({
                    orgId,
                    runId,
                    tx: prisma,
                  });
                  return null;
                }
                case "BACKGROUND_WORKER_MISMATCH": {
                  this.logger.warn(
                    "RunEngine.dequeueFromMasterQueue(): Background worker mismatch",
                    {
                      runId,
                      latestSnapshot: snapshot.id,
                      result,
                    }
                  );

                  //worker mismatch so put it back in the queue
                  await this.runQueue.nackMessage({ orgId, messageId: runId });

                  return null;
                }
                default: {
                  assertExhaustive(result);
                }
              }
            }

            //check for a valid deployment if it's not a development environment
            if (result.run.runtimeEnvironment.type !== "DEVELOPMENT") {
              if (!result.deployment || !result.deployment.imageReference) {
                this.logger.warn("RunEngine.dequeueFromMasterQueue(): No deployment found", {
                  runId,
                  latestSnapshot: snapshot.id,
                  result,
                });
                //not deployed yet, so we'll wait for the deploy
                await this.#waitingForDeploy({
                  orgId,
                  runId,
                  tx: prisma,
                });

                return null;
              }
            }

            const machinePreset = getMachinePreset({
              machines: this.options.machines.machines,
              defaultMachine: this.options.machines.defaultMachine,
              config: result.task.machineConfig ?? {},
              run: result.run,
            });

            //increment the consumed resources
            consumedResources.cpu += machinePreset.cpu;
            consumedResources.memory += machinePreset.memory;

            //are we under the limit?
            if (maxResources) {
              if (
                consumedResources.cpu > maxResources.cpu ||
                consumedResources.memory > maxResources.memory
              ) {
                this.logger.debug(
                  "RunEngine.dequeueFromMasterQueue(): Consumed resources over limit, nacking",
                  {
                    runId,
                    consumedResources,
                    maxResources,
                  }
                );

                //put it back in the queue where it was
                await this.runQueue.nackMessage({
                  orgId,
                  messageId: runId,
                  incrementAttemptCount: false,
                  retryAt: result.run.createdAt.getTime() - result.run.priorityMs,
                });
                return null;
              }
            }

            //update the run
            const lockedTaskRun = await prisma.taskRun.update({
              where: {
                id: runId,
              },
              data: {
                lockedAt: new Date(),
                lockedById: result.task.id,
                lockedToVersionId: result.worker.id,
                startedAt: result.run.startedAt ?? new Date(),
                baseCostInCents: this.options.machines.baseCostInCents,
                machinePreset: machinePreset.name,
                taskVersion: result.worker.version,
                sdkVersion: result.worker.sdkVersion,
                cliVersion: result.worker.cliVersion,
                maxDurationInSeconds: getMaxDuration(
                  result.run.maxDurationInSeconds,
                  result.task.maxDurationInSeconds
                ),
              },
              include: {
                runtimeEnvironment: true,
                attempts: {
                  take: 1,
                  orderBy: { number: "desc" },
                },
                tags: true,
              },
            });

            if (!lockedTaskRun) {
              this.logger.error("RunEngine.dequeueFromMasterQueue(): Failed to lock task run", {
                taskRun: result.run.id,
                taskIdentifier: result.run.taskIdentifier,
                deployment: result.deployment?.id,
                worker: result.worker.id,
                task: result.task.id,
                runId,
              });

              await this.runQueue.acknowledgeMessage(orgId, runId);
              return null;
            }

            const queue = await prisma.taskQueue.findUnique({
              where: {
                runtimeEnvironmentId_name: {
                  runtimeEnvironmentId: lockedTaskRun.runtimeEnvironmentId,
                  name: sanitizeQueueName(lockedTaskRun.queue),
                },
              },
            });

            if (!queue) {
              this.logger.debug(
                "RunEngine.dequeueFromMasterQueue(): queue not found, so nacking message",
                {
                  queueMessage: message,
                  taskRunQueue: lockedTaskRun.queue,
                  runtimeEnvironmentId: lockedTaskRun.runtimeEnvironmentId,
                }
              );

              //will auto-retry
              const gotRequeued = await this.runQueue.nackMessage({ orgId, messageId: runId });
              if (!gotRequeued) {
                await this.#systemFailure({
                  runId,
                  error: {
                    type: "INTERNAL_ERROR",
                    code: "TASK_DEQUEUED_QUEUE_NOT_FOUND",
                    message: `Tried to dequeue the run but the queue doesn't exist: ${lockedTaskRun.queue}`,
                  },
                  tx: prisma,
                });
              }

              return null;
            }

            const currentAttemptNumber = lockedTaskRun.attempts.at(0)?.number ?? 0;
            const nextAttemptNumber = currentAttemptNumber + 1;

            const newSnapshot = await this.#createExecutionSnapshot(prisma, {
              run: {
                id: runId,
                status: snapshot.runStatus,
              },
              snapshot: {
                executionStatus: "PENDING_EXECUTING",
                description: "Run was dequeued for execution",
              },
              checkpointId: snapshot.checkpointId ?? undefined,
              completedWaitpoints: snapshot.completedWaitpoints,
            });

            return {
              version: "1" as const,
              snapshot: {
                id: newSnapshot.id,
                friendlyId: newSnapshot.friendlyId,
                executionStatus: newSnapshot.executionStatus,
                description: newSnapshot.description,
              },
              image: result.deployment?.imageReference ?? undefined,
              checkpoint: newSnapshot.checkpoint ?? undefined,
              completedWaitpoints: snapshot.completedWaitpoints,
              backgroundWorker: {
                id: result.worker.id,
                friendlyId: result.worker.friendlyId,
                version: result.worker.version,
              },
              deployment: {
                id: result.deployment?.id,
                friendlyId: result.deployment?.friendlyId,
              },
              run: {
                id: lockedTaskRun.id,
                friendlyId: lockedTaskRun.friendlyId,
                isTest: lockedTaskRun.isTest,
                machine: machinePreset,
                attemptNumber: nextAttemptNumber,
                masterQueue: lockedTaskRun.masterQueue,
                traceContext: lockedTaskRun.traceContext as Record<string, unknown>,
              },
              environment: {
                id: lockedTaskRun.runtimeEnvironment.id,
                type: lockedTaskRun.runtimeEnvironment.type,
              },
              organization: {
                id: orgId,
              },
              project: {
                id: lockedTaskRun.projectId,
              },
            } satisfies DequeuedMessage;
          });

          if (dequeuedRun !== null) {
            dequeuedRuns.push(dequeuedRun);
          }
        } catch (error) {
          this.logger.error(
            "RunEngine.dequeueFromMasterQueue(): Thrown error while preparing run to be run",
            {
              error,
              runId,
            }
          );

          const run = await prisma.taskRun.findFirst({ where: { id: runId } });

          if (!run) {
            //this isn't ideal because we're not creating a snapshot… but we can't do much else
            this.logger.error(
              "RunEngine.dequeueFromMasterQueue(): Thrown error, then run not found. Nacking.",
              {
                runId,
                orgId,
              }
            );
            await this.runQueue.nackMessage({ orgId, messageId: runId });
            continue;
          }

          //this is an unknown error, we'll reattempt (with auto-backoff and eventually DLQ)
          const gotRequeued = await this.#tryNackAndRequeue({
            run,
            orgId,
            error: {
              type: "INTERNAL_ERROR",
              code: "TASK_RUN_DEQUEUED_MAX_RETRIES",
              message: `We tried to dequeue the run the maximum number of times but it wouldn't start executing`,
            },
            tx: prisma,
          });
          //we don't need this, but it makes it clear we're in a loop here
          continue;
        }
      }

      return dequeuedRuns;
    });
  }

  async dequeueFromEnvironmentMasterQueue({
    consumerId,
    environmentId,
    maxRunCount,
    maxResources,
    backgroundWorkerId,
    tx,
  }: {
    consumerId: string;
    environmentId: string;
    maxRunCount: number;
    maxResources?: MachineResources;
    backgroundWorkerId: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<DequeuedMessage[]> {
    return this.dequeueFromMasterQueue({
      consumerId,
      masterQueue: this.#environmentMasterQueueKey(environmentId),
      maxRunCount,
      maxResources,
      backgroundWorkerId,
      tx,
    });
  }

  async dequeueFromBackgroundWorkerMasterQueue({
    consumerId,
    backgroundWorkerId,
    maxRunCount,
    maxResources,
    tx,
  }: {
    consumerId: string;
    backgroundWorkerId: string;
    maxRunCount: number;
    maxResources?: MachineResources;
    tx?: PrismaClientOrTransaction;
  }): Promise<DequeuedMessage[]> {
    return this.dequeueFromMasterQueue({
      consumerId,
      masterQueue: this.#backgroundWorkerQueueKey(backgroundWorkerId),
      maxRunCount,
      maxResources,
      backgroundWorkerId,
      tx,
    });
  }

  async startRunAttempt({
    runId,
    snapshotId,
    isWarmStart,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    isWarmStart?: boolean;
    tx?: PrismaClientOrTransaction;
  }): Promise<StartRunAttemptResult> {
    const prisma = tx ?? this.prisma;

    return this.#trace("startRunAttempt", { runId, snapshotId }, async (span) => {
      return this.runLock.lock([runId], 5000, async (signal) => {
        const latestSnapshot = await getLatestExecutionSnapshot(prisma, runId);

        if (latestSnapshot.id !== snapshotId) {
          //if there is a big delay between the snapshot and the attempt, the snapshot might have changed
          //we just want to log because elsewhere it should have been put back into a state where it can be attempted
          this.logger.warn(
            "RunEngine.createRunAttempt(): snapshot has changed since the attempt was created, ignoring."
          );
          throw new ServiceValidationError("Snapshot changed", 409);
        }

        const environment = await this.#getAuthenticatedEnvironmentFromRun(runId, prisma);
        if (!environment) {
          throw new ServiceValidationError("Environment not found", 404);
        }

        const taskRun = await prisma.taskRun.findFirst({
          where: {
            id: runId,
          },
          include: {
            tags: true,
            lockedBy: {
              include: {
                worker: {
                  select: {
                    id: true,
                    version: true,
                    sdkVersion: true,
                    cliVersion: true,
                    supportsLazyAttempts: true,
                  },
                },
              },
            },
            batchItems: {
              include: {
                batchTaskRun: true,
              },
            },
          },
        });

        this.logger.debug("Creating a task run attempt", { taskRun });

        if (!taskRun) {
          throw new ServiceValidationError("Task run not found", 404);
        }

        span.setAttribute("projectId", taskRun.projectId);
        span.setAttribute("environmentId", taskRun.runtimeEnvironmentId);
        span.setAttribute("taskRunId", taskRun.id);
        span.setAttribute("taskRunFriendlyId", taskRun.friendlyId);

        if (taskRun.status === "CANCELED") {
          throw new ServiceValidationError("Task run is cancelled", 400);
        }

        if (!taskRun.lockedBy) {
          throw new ServiceValidationError("Task run is not locked", 400);
        }

        const queue = await prisma.taskQueue.findUnique({
          where: {
            runtimeEnvironmentId_name: {
              runtimeEnvironmentId: environment.id,
              name: taskRun.queue,
            },
          },
        });

        if (!queue) {
          throw new ServiceValidationError("Queue not found", 404);
        }

        //increment the attempt number (start at 1)
        const nextAttemptNumber = (taskRun.attemptNumber ?? 0) + 1;

        if (nextAttemptNumber > MAX_TASK_RUN_ATTEMPTS) {
          await this.#attemptFailed({
            runId: taskRun.id,
            snapshotId,
            completion: {
              ok: false,
              id: taskRun.id,
              error: {
                type: "INTERNAL_ERROR",
                code: "TASK_RUN_CRASHED",
                message: "Max attempts reached.",
              },
            },
            tx: prisma,
          });
          throw new ServiceValidationError("Max attempts reached", 400);
        }

        this.eventBus.emit("runAttemptStarted", {
          time: new Date(),
          run: {
            id: taskRun.id,
            attemptNumber: nextAttemptNumber,
            baseCostInCents: taskRun.baseCostInCents,
          },
          organization: {
            id: environment.organization.id,
          },
        });

        const result = await $transaction(
          prisma,
          async (tx) => {
            const run = await tx.taskRun.update({
              where: {
                id: taskRun.id,
              },
              data: {
                status: "EXECUTING",
                attemptNumber: nextAttemptNumber,
                firstAttemptStartedAt: taskRun.attemptNumber === null ? new Date() : undefined,
              },
              include: {
                tags: true,
                lockedBy: {
                  include: { worker: true },
                },
              },
            });

            const newSnapshot = await this.#createExecutionSnapshot(tx, {
              run,
              snapshot: {
                executionStatus: "EXECUTING",
                description: `Attempt created, starting execution${
                  isWarmStart ? " (warm start)" : ""
                }`,
              },
            });

            if (taskRun.ttl) {
              //don't expire the run, it's going to execute
              await this.worker.ack(`expireRun:${taskRun.id}`);
            }

            return { run, snapshot: newSnapshot };
          },
          (error) => {
            this.logger.error("RunEngine.createRunAttempt(): prisma.$transaction error", {
              code: error.code,
              meta: error.meta,
              stack: error.stack,
              message: error.message,
              name: error.name,
            });
            throw new ServiceValidationError(
              "Failed to update task run and execution snapshot",
              500
            );
          }
        );

        if (!result) {
          this.logger.error("RunEngine.createRunAttempt(): failed to create task run attempt", {
            runId: taskRun.id,
            nextAttemptNumber,
          });
          throw new ServiceValidationError("Failed to create task run attempt", 500);
        }

        const { run, snapshot } = result;

        const machinePreset = getMachinePreset({
          machines: this.options.machines.machines,
          defaultMachine: this.options.machines.defaultMachine,
          config: taskRun.lockedBy.machineConfig ?? {},
          run: taskRun,
        });

        const metadata = await parsePacket({
          data: taskRun.metadata ?? undefined,
          dataType: taskRun.metadataType,
        });

        const execution: TaskRunExecution = {
          task: {
            id: run.lockedBy!.slug,
            filePath: run.lockedBy!.filePath,
            exportName: run.lockedBy!.exportName,
          },
          attempt: {
            number: nextAttemptNumber,
            startedAt: latestSnapshot.updatedAt,
            /** @deprecated */
            id: "deprecated",
            /** @deprecated */
            backgroundWorkerId: "deprecated",
            /** @deprecated */
            backgroundWorkerTaskId: "deprecated",
            /** @deprecated */
            status: "deprecated",
          },
          run: {
            id: run.friendlyId,
            payload: run.payload,
            payloadType: run.payloadType,
            createdAt: run.createdAt,
            tags: run.tags.map((tag) => tag.name),
            isTest: run.isTest,
            idempotencyKey: run.idempotencyKey ?? undefined,
            startedAt: run.startedAt ?? run.createdAt,
            maxAttempts: run.maxAttempts ?? undefined,
            version: run.lockedBy!.worker.version,
            metadata,
            maxDuration: run.maxDurationInSeconds ?? undefined,
            /** @deprecated */
            context: undefined,
            /** @deprecated */
            durationMs: run.usageDurationMs,
            /** @deprecated */
            costInCents: run.costInCents,
            /** @deprecated */
            baseCostInCents: run.baseCostInCents,
            traceContext: run.traceContext as Record<string, string | undefined>,
          },
          queue: {
            id: queue.friendlyId,
            name: queue.name,
          },
          environment: {
            id: environment.id,
            slug: environment.slug,
            type: environment.type,
          },
          organization: {
            id: environment.organization.id,
            slug: environment.organization.slug,
            name: environment.organization.title,
          },
          project: {
            id: environment.project.id,
            ref: environment.project.externalRef,
            slug: environment.project.slug,
            name: environment.project.name,
          },
          batch:
            taskRun.batchItems[0] && taskRun.batchItems[0].batchTaskRun
              ? { id: taskRun.batchItems[0].batchTaskRun.friendlyId }
              : undefined,
          machine: machinePreset,
        };

        return { run, snapshot, execution };
      });
    });
  }

  /** How a run is completed */
  async completeRunAttempt({
    runId,
    snapshotId,
    completion,
  }: {
    runId: string;
    snapshotId: string;
    completion: TaskRunExecutionResult;
  }): Promise<CompleteRunAttemptResult> {
    if (completion.metadata) {
      this.eventBus.emit("runMetadataUpdated", {
        time: new Date(),
        run: {
          id: runId,
          metadata: completion.metadata,
        },
      });
    }

    switch (completion.ok) {
      case true: {
        return this.#attemptSucceeded({ runId, snapshotId, completion, tx: this.prisma });
      }
      case false: {
        return this.#attemptFailed({ runId, snapshotId, completion, tx: this.prisma });
      }
    }
  }

  async waitForDuration({
    runId,
    snapshotId,
    date,
    releaseConcurrency = true,
    idempotencyKey,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    date: Date;
    releaseConcurrency?: boolean;
    idempotencyKey?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<WaitForDurationResult> {
    const prisma = tx ?? this.prisma;

    return await this.runLock.lock([runId], 5_000, async (signal) => {
      const snapshot = await getLatestExecutionSnapshot(prisma, runId);

      if (snapshot.id !== snapshotId) {
        throw new ServiceValidationError("Snapshot ID doesn't match the latest snapshot", 400);
      }

      const run = await prisma.taskRun.findFirst({
        select: {
          runtimeEnvironment: {
            select: {
              id: true,
              organizationId: true,
            },
          },
          projectId: true,
        },
        where: { id: runId },
      });

      if (!run) {
        throw new ServiceValidationError("TaskRun not found", 404);
      }

      let waitpoint = idempotencyKey
        ? await prisma.waitpoint.findUnique({
            where: {
              environmentId_idempotencyKey: {
                environmentId: run.runtimeEnvironment.id,
                idempotencyKey,
              },
            },
          })
        : undefined;

      if (!waitpoint) {
        waitpoint = await this.#createDateTimeWaitpoint(prisma, {
          projectId: run.projectId,
          environmentId: run.runtimeEnvironment.id,
          completedAfter: date,
          idempotencyKey,
        });
      }

      //waitpoint already completed, so we don't need to wait
      if (waitpoint.status === "COMPLETED") {
        return {
          waitUntil: waitpoint.completedAt ?? new Date(),
          waitpoint: {
            id: waitpoint.id,
          },
          ...executionResultFromSnapshot(snapshot),
        };
      }

      //block the run
      const blockResult = await this.blockRunWithWaitpoint({
        runId,
        waitpoints: waitpoint.id,
        environmentId: waitpoint.environmentId,
        projectId: waitpoint.projectId,
        tx: prisma,
      });

      //release concurrency
      await this.runQueue.releaseConcurrency(
        run.runtimeEnvironment.organizationId,
        runId,
        releaseConcurrency
      );

      return {
        waitUntil: date,
        waitpoint: {
          id: waitpoint.id,
        },
        ...executionResultFromSnapshot(blockResult),
      };
    });
  }

  /**
  Call this to cancel a run.
  If the run is in-progress it will change it's state to PENDING_CANCEL and notify the worker.
  If the run is not in-progress it will finish it.
  You can pass `finalizeRun` in if you know it's no longer running, e.g. the worker has messaged to say it's done.
  */
  async cancelRun({
    runId,
    completedAt,
    reason,
    finalizeRun,
    tx,
  }: {
    runId: string;
    completedAt?: Date;
    reason?: string;
    finalizeRun?: boolean;
    tx?: PrismaClientOrTransaction;
  }): Promise<ExecutionResult> {
    const prisma = tx ?? this.prisma;
    reason = reason ?? "Cancelled by user";

    return this.#trace("cancelRun", { runId }, async (span) => {
      return this.runLock.lock([runId], 5_000, async (signal) => {
        const latestSnapshot = await getLatestExecutionSnapshot(prisma, runId);

        //already finished, do nothing
        if (latestSnapshot.executionStatus === "FINISHED") {
          return executionResultFromSnapshot(latestSnapshot);
        }

        //is pending cancellation and we're not finalizing, alert the worker again
        if (latestSnapshot.executionStatus === "PENDING_CANCEL" && !finalizeRun) {
          await this.#sendNotificationToWorker({ runId });
          return executionResultFromSnapshot(latestSnapshot);
        }

        //set the run to cancelled immediately
        const error: TaskRunError = {
          type: "STRING_ERROR",
          raw: reason,
        };

        const run = await prisma.taskRun.update({
          where: { id: runId },
          data: {
            status: "CANCELED",
            completedAt: finalizeRun ? completedAt ?? new Date() : completedAt,
            error,
          },
          include: {
            runtimeEnvironment: true,
            associatedWaitpoint: true,
            childRuns: {
              select: {
                id: true,
              },
            },
          },
        });

        //remove it from the queue and release concurrency
        await this.runQueue.acknowledgeMessage(run.runtimeEnvironment.organizationId, runId);

        //if executing, we need to message the worker to cancel the run and put it into `PENDING_CANCEL` status
        if (isExecuting(latestSnapshot.executionStatus)) {
          const newSnapshot = await this.#createExecutionSnapshot(prisma, {
            run,
            snapshot: {
              executionStatus: "PENDING_CANCEL",
              description: "Run was cancelled",
            },
          });

          //the worker needs to be notified so it can kill the run and complete the attempt
          await this.#sendNotificationToWorker({ runId });
          return executionResultFromSnapshot(newSnapshot);
        }

        //not executing, so we will actually finish the run
        const newSnapshot = await this.#createExecutionSnapshot(prisma, {
          run,
          snapshot: {
            executionStatus: "FINISHED",
            description: "Run was cancelled, not finished",
          },
        });

        if (!run.associatedWaitpoint) {
          throw new ServiceValidationError("No associated waitpoint found", 400);
        }

        //complete the waitpoint so the parent run can continue
        await this.completeWaitpoint({
          id: run.associatedWaitpoint.id,
          output: { value: JSON.stringify(error), isError: true },
        });

        this.eventBus.emit("runCancelled", {
          time: new Date(),
          run: {
            id: run.id,
            friendlyId: run.friendlyId,
            spanId: run.spanId,
            error,
          },
        });

        //schedule the cancellation of all the child runs
        //it will call this function for each child,
        //which will recursively cancel all children if they need to be
        if (run.childRuns.length > 0) {
          for (const childRun of run.childRuns) {
            await this.worker.enqueue({
              id: `cancelRun:${childRun.id}`,
              job: "cancelRun",
              payload: { runId: childRun.id, completedAt: run.completedAt ?? new Date(), reason },
            });
          }
        }

        await this.#finalizeRun(run);

        return executionResultFromSnapshot(newSnapshot);
      });
    });
  }

  async queueRunsWaitingForWorker({
    backgroundWorkerId,
  }: {
    backgroundWorkerId: string;
  }): Promise<void> {
    //we want this to happen in the background
    await this.worker.enqueue({
      job: "queueRunsWaitingForWorker",
      payload: { backgroundWorkerId },
    });
  }

  /**
   * Reschedules a delayed run where the run hasn't been queued yet
   */
  async rescheduleRun({
    runId,
    delayUntil,
    tx,
  }: {
    runId: string;
    delayUntil: Date;
    tx?: PrismaClientOrTransaction;
  }): Promise<TaskRun> {
    const prisma = tx ?? this.prisma;
    return this.#trace("rescheduleRun", { runId }, async (span) => {
      return await this.runLock.lock([runId], 5_000, async (signal) => {
        const snapshot = await getLatestExecutionSnapshot(prisma, runId);

        //if the run isn't just created then we can't reschedule it
        if (snapshot.executionStatus !== "RUN_CREATED") {
          throw new ServiceValidationError("Cannot reschedule a run that is not delayed");
        }

        const updatedRun = await prisma.taskRun.update({
          where: {
            id: runId,
          },
          data: {
            delayUntil: delayUntil,
            executionSnapshots: {
              create: {
                engine: "V2",
                executionStatus: "RUN_CREATED",
                description: "Delayed run was rescheduled to a future date",
                runStatus: "EXPIRED",
              },
            },
          },
          include: {
            blockedByWaitpoints: true,
          },
        });

        if (updatedRun.blockedByWaitpoints.length === 0) {
          throw new ServiceValidationError(
            "Cannot reschedule a run that is not blocked by a waitpoint"
          );
        }

        const result = await this.#rescheduleDateTimeWaitpoint(
          prisma,
          updatedRun.blockedByWaitpoints[0].waitpointId,
          delayUntil
        );

        if (!result.success) {
          throw new ServiceValidationError("Failed to reschedule waitpoint, too late.", 400);
        }

        return updatedRun;
      });
    });
  }

  async lengthOfEnvQueue(environment: MinimalAuthenticatedEnvironment): Promise<number> {
    return this.runQueue.lengthOfEnvQueue(environment);
  }

  /** This creates a MANUAL waitpoint, that can be explicitly completed (or failed).
   * If you pass an `idempotencyKey` and it already exists, it will return the existing waitpoint.
   */
  async createManualWaitpoint({
    environmentId,
    projectId,
    idempotencyKey,
  }: {
    environmentId: string;
    projectId: string;
    idempotencyKey?: string;
  }): Promise<Waitpoint> {
    const existingWaitpoint = idempotencyKey
      ? await this.prisma.waitpoint.findUnique({
          where: {
            environmentId_idempotencyKey: {
              environmentId,
              idempotencyKey,
            },
          },
        })
      : undefined;

    if (existingWaitpoint) {
      return existingWaitpoint;
    }

    return this.prisma.waitpoint.create({
      data: {
        ...WaitpointId.generate(),
        type: "MANUAL",
        idempotencyKey: idempotencyKey ?? nanoid(24),
        userProvidedIdempotencyKey: !!idempotencyKey,
        environmentId,
        projectId,
      },
    });
  }

  /** This block a run with a BATCH waitpoint.
   * The waitpoint will be created, and it will block the parent run.
   */
  async blockRunWithCreatedBatch({
    runId,
    batchId,
    environmentId,
    projectId,
    tx,
  }: {
    runId: string;
    batchId: string;
    environmentId: string;
    projectId: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<Waitpoint | null> {
    const prisma = tx ?? this.prisma;

    try {
      const waitpoint = await prisma.waitpoint.create({
        data: {
          ...WaitpointId.generate(),
          type: "BATCH",
          idempotencyKey: batchId,
          userProvidedIdempotencyKey: false,
          completedByBatchId: batchId,
          environmentId,
          projectId,
        },
      });

      await this.blockRunWithWaitpoint({
        runId,
        waitpoints: waitpoint.id,
        environmentId,
        projectId,
        batch: { id: batchId },
        tx: prisma,
      });

      return waitpoint;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        // duplicate idempotency key
        if (error.code === "P2002") {
          return null;
        } else {
          throw error;
        }
      }
      throw error;
    }
  }

  /**
   * This is called when all the runs for a batch have been created.
   * This does NOT mean that all the runs for the batch are completed.
   */
  async unblockRunForCreatedBatch({
    runId,
    batchId,
    environmentId,
    projectId,
    tx,
  }: {
    runId: string;
    batchId: string;
    environmentId: string;
    projectId: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<void> {
    const prisma = tx ?? this.prisma;

    const waitpoint = await prisma.waitpoint.findFirst({
      where: {
        completedByBatchId: batchId,
      },
    });

    if (!waitpoint) {
      this.logger.error("RunEngine.unblockRunForBatch(): Waitpoint not found", {
        runId,
        batchId,
      });
      throw new ServiceValidationError("Waitpoint not found for batch", 404);
    }

    await this.completeWaitpoint({
      id: waitpoint.id,
      output: { value: "Batch waitpoint completed", isError: false },
    });
  }

  async tryCompleteBatch({ batchId }: { batchId: string }): Promise<void> {
    await this.worker.enqueue({
      //this will debounce the call
      id: `tryCompleteBatch:${batchId}`,
      job: "tryCompleteBatch",
      payload: { batchId: batchId },
      //2s in the future
      availableAt: new Date(Date.now() + 2_000),
    });
  }

  async getWaitpoint({
    waitpointId,
    environmentId,
    projectId,
  }: {
    environmentId: string;
    projectId: string;
    waitpointId: string;
  }): Promise<Waitpoint | null> {
    const waitpoint = await this.prisma.waitpoint.findFirst({
      where: { id: waitpointId },
      include: {
        blockingTaskRuns: {
          select: {
            taskRun: {
              select: {
                id: true,
                friendlyId: true,
              },
            },
          },
        },
      },
    });

    if (!waitpoint) return null;
    if (waitpoint.environmentId !== environmentId) return null;

    return waitpoint;
  }

  /**
   * Prevents a run from continuing until the waitpoint is completed.
   */
  async blockRunWithWaitpoint({
    runId,
    waitpoints,
    projectId,
    failAfter,
    spanIdToComplete,
    batch,
    tx,
  }: {
    runId: string;
    waitpoints: string | string[];
    environmentId: string;
    projectId: string;
    failAfter?: Date;
    spanIdToComplete?: string;
    batch?: { id: string; index?: number };
    tx?: PrismaClientOrTransaction;
  }): Promise<TaskRunExecutionSnapshot> {
    const prisma = tx ?? this.prisma;

    let $waitpoints = typeof waitpoints === "string" ? [waitpoints] : waitpoints;

    return await this.runLock.lock([runId], 5000, async (signal) => {
      let snapshot: TaskRunExecutionSnapshot = await getLatestExecutionSnapshot(prisma, runId);

      //block the run with the waitpoints, returning how many waitpoints are pending
      const insert = await prisma.$queryRaw<{ pending_count: BigInt }[]>`
        WITH inserted AS (
          INSERT INTO "TaskRunWaitpoint" ("id", "taskRunId", "waitpointId", "projectId", "createdAt", "updatedAt", "spanIdToComplete", "batchId", "batchIndex")
          SELECT
            gen_random_uuid(),
            ${runId},
            w.id,
            ${projectId},
            NOW(),
            NOW(),
            ${spanIdToComplete ?? null},
            ${batch?.id ?? null},
            ${batch?.index ?? null}
          FROM "Waitpoint" w
          WHERE w.id IN (${Prisma.join($waitpoints)})
          ON CONFLICT DO NOTHING
          RETURNING "waitpointId"
        )
        SELECT COUNT(*) as pending_count
        FROM inserted i
        JOIN "Waitpoint" w ON w.id = i."waitpointId"
        WHERE w.status = 'PENDING';`;

      const pendingCount = Number(insert.at(0)?.pending_count ?? 0);

      let newStatus: TaskRunExecutionStatus = "SUSPENDED";
      if (
        snapshot.executionStatus === "EXECUTING" ||
        snapshot.executionStatus === "EXECUTING_WITH_WAITPOINTS"
      ) {
        newStatus = "EXECUTING_WITH_WAITPOINTS";
      }

      //if the state has changed, create a new snapshot
      if (newStatus !== snapshot.executionStatus) {
        snapshot = await this.#createExecutionSnapshot(prisma, {
          run: {
            id: snapshot.runId,
            status: snapshot.runStatus,
            attemptNumber: snapshot.attemptNumber,
          },
          snapshot: {
            executionStatus: newStatus,
            description: "Run was blocked by a waitpoint.",
          },
          batchId: batch?.id ?? snapshot.batchId ?? undefined,
        });
      }

      if (failAfter) {
        for (const waitpoint of $waitpoints) {
          await this.worker.enqueue({
            id: `finishWaitpoint.${waitpoint}`,
            job: "finishWaitpoint",
            payload: { waitpointId: waitpoint, error: "Waitpoint timed out" },
            availableAt: failAfter,
          });
        }
      }

      //no pending waitpoint, schedule unblocking the run
      //debounce if we're rapidly adding waitpoints
      if (pendingCount === 0) {
        await this.worker.enqueue({
          //this will debounce the call
          id: `continueRunIfUnblocked:${runId}`,
          job: "continueRunIfUnblocked",
          payload: { runId: runId },
          //100ms in the future
          availableAt: new Date(Date.now() + 100),
        });
      }

      return snapshot;
    });
  }

  /** This completes a waitpoint and updates all entries so the run isn't blocked,
   * if they're no longer blocked. This doesn't suffer from race conditions. */
  async completeWaitpoint({
    id,
    output,
  }: {
    id: string;
    output?: {
      value: string;
      type?: string;
      isError: boolean;
    };
  }): Promise<Waitpoint> {
    const waitpoint = await this.prisma.waitpoint.findUnique({
      where: { id },
    });

    if (!waitpoint) {
      throw new Error(`Waitpoint ${id} not found`);
    }

    const result = await $transaction(
      this.prisma,
      async (tx) => {
        // 1. Find the TaskRuns blocked by this waitpoint
        const affectedTaskRuns = await tx.taskRunWaitpoint.findMany({
          where: { waitpointId: id },
          select: { taskRunId: true, spanIdToComplete: true },
        });

        if (affectedTaskRuns.length === 0) {
          this.logger.warn(`No TaskRunWaitpoints found for waitpoint`, {
            waitpoint,
          });
        }

        // 2. Update the waitpoint to completed
        const updatedWaitpoint = await tx.waitpoint.update({
          where: { id },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            output: output?.value,
            outputType: output?.type,
            outputIsError: output?.isError,
          },
        });

        return { updatedWaitpoint, affectedTaskRuns };
      },
      (error) => {
        this.logger.error(`Error completing waitpoint ${id}, retrying`, { error });
        throw error;
      }
    );

    if (!result) {
      throw new Error(`Waitpoint couldn't be updated`);
    }

    //schedule trying to continue the runs
    for (const run of result.affectedTaskRuns) {
      await this.worker.enqueue({
        //this will debounce the call
        id: `continueRunIfUnblocked:${run.taskRunId}`,
        job: "continueRunIfUnblocked",
        payload: { runId: run.taskRunId },
        //50ms in the future
        availableAt: new Date(Date.now() + 50),
      });

      // emit an event to complete associated cached runs
      if (run.spanIdToComplete) {
        this.eventBus.emit("cachedRunCompleted", {
          time: new Date(),
          spanId: run.spanIdToComplete,
          hasError: output?.isError ?? false,
        });
      }
    }

    return result.updatedWaitpoint;
  }

  async createCheckpoint({
    runId,
    snapshotId,
    checkpoint,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    //todo
    checkpoint: Record<string, unknown>;
    tx?: PrismaClientOrTransaction;
  }) {
    const prisma = tx ?? this.prisma;

    return await this.runLock.lock([runId], 5_000, async (signal) => {
      const snapshot = await getLatestExecutionSnapshot(prisma, runId);
      if (snapshot.id !== snapshotId) {
        return {
          ok: false as const,
          error: "Not the latest snapshot",
        };
      }

      //todo check the status is checkpointable
      if (!isCheckpointable(snapshot.executionStatus)) {
        this.logger.error("Tried to createCheckpoint on a run in an invalid state", {
          snapshot,
        });

        //check if the server should already be shutting down, if so return a result saying it can shutdown but that there's no checkpoint

        //otherwise return a result saying it can't checkpoint with an error and execution status

        return;
      }

      //create a new execution snapshot, with the checkpoint

      //todo return a Result, which will determine if the server is allowed to shutdown
    });
  }

  /**
  Send a heartbeat to signal the the run is still executing.
  If a heartbeat isn't received, after a while the run is considered "stalled"
  and some logic will be run to try recover it.
  @returns The ExecutionResult, which could be a different snapshot.
  */
  async heartbeatRun({
    runId,
    snapshotId,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<ExecutionResult> {
    const prisma = tx ?? this.prisma;

    //we don't need to acquire a run lock for any of this, it's not critical if it happens on an older version
    const latestSnapshot = await getLatestExecutionSnapshot(prisma, runId);
    if (latestSnapshot.id !== snapshotId) {
      this.logger.log("heartbeatRun no longer the latest snapshot, stopping the heartbeat.", {
        runId,
        snapshotId,
        latestSnapshot: latestSnapshot,
      });

      await this.worker.ack(`heartbeatSnapshot.${snapshotId}`);
      return executionResultFromSnapshot(latestSnapshot);
    }

    //update the snapshot heartbeat time
    await prisma.taskRunExecutionSnapshot.update({
      where: { id: latestSnapshot.id },
      data: {
        lastHeartbeatAt: new Date(),
      },
    });

    //extending is the same as creating a new heartbeat
    await this.#setHeartbeatDeadline({ runId, snapshotId, status: latestSnapshot.executionStatus });

    return executionResultFromSnapshot(latestSnapshot);
  }

  /** Get required data to execute the run */
  async getRunExecutionData({
    runId,
    tx,
  }: {
    runId: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<RunExecutionData | null> {
    const prisma = tx ?? this.prisma;
    try {
      const snapshot = await getLatestExecutionSnapshot(prisma, runId);

      const executionData: RunExecutionData = {
        version: "1" as const,
        snapshot: {
          id: snapshot.id,
          friendlyId: snapshot.friendlyId,
          executionStatus: snapshot.executionStatus,
          description: snapshot.description,
        },
        run: {
          id: snapshot.runId,
          friendlyId: snapshot.runFriendlyId,
          status: snapshot.runStatus,
          attemptNumber: snapshot.attemptNumber ?? undefined,
        },
        batch: snapshot.batchId
          ? {
              id: snapshot.batchId,
              friendlyId: BatchId.toFriendlyId(snapshot.batchId),
            }
          : undefined,
        checkpoint: snapshot.checkpoint
          ? {
              id: snapshot.checkpoint.id,
              friendlyId: snapshot.checkpoint.friendlyId,
              type: snapshot.checkpoint.type,
              location: snapshot.checkpoint.location,
              imageRef: snapshot.checkpoint.imageRef,
              reason: snapshot.checkpoint.reason ?? undefined,
            }
          : undefined,
        completedWaitpoints: snapshot.completedWaitpoints,
      };

      return executionData;
    } catch (e) {
      this.logger.error("Failed to getRunExecutionData", {
        message: e instanceof Error ? e.message : e,
      });
      return null;
    }
  }

  async quit() {
    //stop the run queue
    await this.runQueue.quit();
    await this.worker.stop();
    await this.runLock.quit();

    try {
      // This is just a failsafe
      await this.redis.quit();
    } catch (error) {
      // And should always throw
    }
  }

  async #systemFailure({
    runId,
    error,
    tx,
  }: {
    runId: string;
    error: TaskRunInternalError;
    tx?: PrismaClientOrTransaction;
  }): Promise<CompleteRunAttemptResult> {
    const prisma = tx ?? this.prisma;
    return this.#trace("#systemFailure", { runId }, async (span) => {
      const latestSnapshot = await getLatestExecutionSnapshot(prisma, runId);

      //already finished
      if (latestSnapshot.executionStatus === "FINISHED") {
        //todo check run is in the correct state
        return {
          attemptStatus: "RUN_FINISHED",
          snapshot: latestSnapshot,
          run: {
            id: runId,
            friendlyId: latestSnapshot.runFriendlyId,
            status: latestSnapshot.runStatus,
            attemptNumber: latestSnapshot.attemptNumber,
          },
        };
      }

      const result = await this.#attemptFailed({
        runId,
        snapshotId: latestSnapshot.id,
        completion: {
          ok: false,
          id: runId,
          error,
        },
        tx: prisma,
      });

      return result;
    });
  }

  async #expireRun({ runId, tx }: { runId: string; tx?: PrismaClientOrTransaction }) {
    const prisma = tx ?? this.prisma;
    await this.runLock.lock([runId], 5_000, async (signal) => {
      const snapshot = await getLatestExecutionSnapshot(prisma, runId);

      //if we're executing then we won't expire the run
      if (isExecuting(snapshot.executionStatus)) {
        return;
      }

      //only expire "PENDING" runs
      const run = await prisma.taskRun.findUnique({ where: { id: runId } });

      if (!run) {
        this.logger.debug("Could not find enqueued run to expire", {
          runId,
        });
        return;
      }

      if (run.status !== "PENDING") {
        this.logger.debug("Run cannot be expired because it's not in PENDING status", {
          run,
        });
        return;
      }

      if (run.lockedAt) {
        this.logger.debug("Run cannot be expired because it's locked, so will run", {
          run,
        });
        return;
      }

      const error: TaskRunError = {
        type: "STRING_ERROR",
        raw: `Run expired because the TTL (${run.ttl}) was reached`,
      };

      const updatedRun = await prisma.taskRun.update({
        where: { id: runId },
        data: {
          status: "EXPIRED",
          completedAt: new Date(),
          expiredAt: new Date(),
          error,
          executionSnapshots: {
            create: {
              engine: "V2",
              executionStatus: "FINISHED",
              description: "Run was expired because the TTL was reached",
              runStatus: "EXPIRED",
            },
          },
        },
        include: {
          associatedWaitpoint: true,
        },
      });

      if (!updatedRun.associatedWaitpoint) {
        throw new ServiceValidationError("No associated waitpoint found", 400);
      }

      await this.completeWaitpoint({
        id: updatedRun.associatedWaitpoint.id,
        output: { value: JSON.stringify(error), isError: true },
      });

      this.eventBus.emit("runExpired", { run: updatedRun, time: new Date() });
    });
  }

  async #waitingForDeploy({
    orgId,
    runId,
    tx,
  }: {
    orgId: string;
    runId: string;
    tx?: PrismaClientOrTransaction;
  }) {
    const prisma = tx ?? this.prisma;

    return this.#trace("#waitingForDeploy", { runId }, async (span) => {
      return this.runLock.lock([runId], 5_000, async (signal) => {
        //mark run as waiting for deploy
        const run = await prisma.taskRun.update({
          where: { id: runId },
          data: {
            status: "WAITING_FOR_DEPLOY",
          },
        });

        await this.#createExecutionSnapshot(prisma, {
          run,
          snapshot: {
            executionStatus: "RUN_CREATED",
            description:
              "The run doesn't have a background worker, so we're going to ack it for now.",
          },
        });

        //we ack because when it's deployed it will be requeued
        await this.runQueue.acknowledgeMessage(orgId, runId);
      });
    });
  }

  async #attemptSucceeded({
    runId,
    snapshotId,
    completion,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    completion: TaskRunSuccessfulExecutionResult;
    tx: PrismaClientOrTransaction;
  }): Promise<CompleteRunAttemptResult> {
    const prisma = tx ?? this.prisma;
    return this.#trace("#completeRunAttemptSuccess", { runId, snapshotId }, async (span) => {
      return this.runLock.lock([runId], 5_000, async (signal) => {
        const latestSnapshot = await getLatestExecutionSnapshot(prisma, runId);

        if (latestSnapshot.id !== snapshotId) {
          throw new ServiceValidationError("Snapshot ID doesn't match the latest snapshot", 400);
        }

        span.setAttribute("completionStatus", completion.ok);

        const completedAt = new Date();

        const run = await prisma.taskRun.update({
          where: { id: runId },
          data: {
            status: "COMPLETED_SUCCESSFULLY",
            completedAt,
            output: completion.output,
            outputType: completion.outputType,
            executionSnapshots: {
              create: {
                executionStatus: "FINISHED",
                description: "Task completed successfully",
                runStatus: "COMPLETED_SUCCESSFULLY",
                attemptNumber: latestSnapshot.attemptNumber,
              },
            },
          },
          select: {
            id: true,
            friendlyId: true,
            status: true,
            attemptNumber: true,
            spanId: true,
            associatedWaitpoint: {
              select: {
                id: true,
              },
            },
            project: {
              select: {
                organizationId: true,
              },
            },
            batchId: true,
          },
        });
        const newSnapshot = await getLatestExecutionSnapshot(prisma, runId);
        await this.runQueue.acknowledgeMessage(run.project.organizationId, runId);

        // We need to manually emit this as we created the final snapshot as part of the task run update
        this.eventBus.emit("executionSnapshotCreated", {
          time: newSnapshot.createdAt,
          run: {
            id: newSnapshot.runId,
          },
          snapshot: {
            ...newSnapshot,
            completedWaitpointIds: newSnapshot.completedWaitpoints.map((wp) => wp.id),
          },
        });

        if (!run.associatedWaitpoint) {
          throw new ServiceValidationError("No associated waitpoint found", 400);
        }

        await this.completeWaitpoint({
          id: run.associatedWaitpoint.id,
          output: completion.output
            ? { value: completion.output, type: completion.outputType, isError: false }
            : undefined,
        });

        this.eventBus.emit("runSucceeded", {
          time: completedAt,
          run: {
            id: runId,
            spanId: run.spanId,
            output: completion.output,
            outputType: completion.outputType,
          },
        });

        await this.#finalizeRun(run);

        return {
          attemptStatus: "RUN_FINISHED",
          snapshot: newSnapshot,
          run,
        };
      });
    });
  }

  async #attemptFailed({
    runId,
    snapshotId,
    completion,
    forceRequeue,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    completion: TaskRunFailedExecutionResult;
    forceRequeue?: boolean;
    tx: PrismaClientOrTransaction;
  }): Promise<CompleteRunAttemptResult> {
    const prisma = this.prisma;

    return this.#trace("completeRunAttemptFailure", { runId, snapshotId }, async (span) => {
      return this.runLock.lock([runId], 5_000, async (signal) => {
        const latestSnapshot = await getLatestExecutionSnapshot(prisma, runId);

        if (latestSnapshot.id !== snapshotId) {
          throw new ServiceValidationError("Snapshot ID doesn't match the latest snapshot", 400);
        }

        span.setAttribute("completionStatus", completion.ok);

        //remove waitpoints blocking the run
        const deletedCount = await this.#clearBlockingWaitpoints({ runId, tx });
        if (deletedCount > 0) {
          this.logger.debug("Cleared blocking waitpoints", { runId, deletedCount });
        }

        const failedAt = new Date();

        if (
          completion.error.type === "INTERNAL_ERROR" &&
          completion.error.code === "TASK_RUN_CANCELLED"
        ) {
          // We need to cancel the task run instead of fail it
          const result = await this.cancelRun({
            runId,
            completedAt: failedAt,
            reason: completion.error.message,
            finalizeRun: true,
            tx: prisma,
          });
          return {
            attemptStatus:
              result.snapshot.executionStatus === "PENDING_CANCEL"
                ? "RUN_PENDING_CANCEL"
                : "RUN_FINISHED",
            ...result,
          };
        }

        const error = sanitizeError(completion.error);
        const retriableError = shouldRetryError(taskRunErrorEnhancer(completion.error));

        if (
          retriableError &&
          completion.retry !== undefined &&
          latestSnapshot.attemptNumber !== null &&
          latestSnapshot.attemptNumber < MAX_TASK_RUN_ATTEMPTS
        ) {
          const retryAt = new Date(completion.retry.timestamp);

          const run = await prisma.taskRun.update({
            where: {
              id: runId,
            },
            data: {
              status: "RETRYING_AFTER_FAILURE",
            },
            include: {
              runtimeEnvironment: {
                include: {
                  project: true,
                  organization: true,
                  orgMember: true,
                },
              },
            },
          });

          const nextAttemptNumber =
            latestSnapshot.attemptNumber === null ? 1 : latestSnapshot.attemptNumber + 1;

          this.eventBus.emit("runRetryScheduled", {
            time: failedAt,
            run: {
              id: run.id,
              friendlyId: run.friendlyId,
              attemptNumber: nextAttemptNumber,
              queue: run.queue,
              taskIdentifier: run.taskIdentifier,
              traceContext: run.traceContext as Record<string, string | undefined>,
              baseCostInCents: run.baseCostInCents,
              spanId: run.spanId,
            },
            organization: {
              id: run.runtimeEnvironment.organizationId,
            },
            environment: run.runtimeEnvironment,
            retryAt,
          });

          //todo anything special for DEV? Ideally not.

          //if it's a long delay and we support checkpointing, put it back in the queue
          if (
            forceRequeue ||
            (this.options.retryWarmStartThresholdMs !== undefined &&
              completion.retry.delay >= this.options.retryWarmStartThresholdMs)
          ) {
            //we nack the message, requeuing it for later
            const nackResult = await this.#tryNackAndRequeue({
              run,
              orgId: run.runtimeEnvironment.organizationId,
              timestamp: retryAt.getTime(),
              error: {
                type: "INTERNAL_ERROR",
                code: "TASK_RUN_DEQUEUED_MAX_RETRIES",
                message: `We tried to dequeue the run the maximum number of times but it wouldn't start executing`,
              },
              tx: prisma,
            });

            if (!nackResult.wasRequeued) {
              return {
                attemptStatus: "RUN_FINISHED",
                ...nackResult,
              };
            } else {
              return { attemptStatus: "RETRY_QUEUED", ...nackResult };
            }
          }

          //it will continue running because the retry delay is short
          const newSnapshot = await this.#createExecutionSnapshot(prisma, {
            run,
            snapshot: {
              executionStatus: "PENDING_EXECUTING",
              description: "Attempt failed wth a short delay, starting a new attempt.",
            },
          });
          //the worker can fetch the latest snapshot and should create a new attempt
          await this.#sendNotificationToWorker({ runId });

          return {
            attemptStatus: "RETRY_IMMEDIATELY",
            ...executionResultFromSnapshot(newSnapshot),
          };
        }

        const status = runStatusFromError(completion.error);

        //run permanently failed
        const run = await prisma.taskRun.update({
          where: {
            id: runId,
          },
          data: {
            status,
            completedAt: failedAt,
            error,
          },
          include: {
            runtimeEnvironment: true,
            associatedWaitpoint: true,
          },
        });

        const newSnapshot = await this.#createExecutionSnapshot(prisma, {
          run,
          snapshot: {
            executionStatus: "FINISHED",
            description: "Run failed",
          },
        });

        if (!run.associatedWaitpoint) {
          throw new ServiceValidationError("No associated waitpoint found", 400);
        }

        await this.completeWaitpoint({
          id: run.associatedWaitpoint.id,
          output: { value: JSON.stringify(error), isError: true },
        });

        await this.runQueue.acknowledgeMessage(run.runtimeEnvironment.organizationId, runId);

        this.eventBus.emit("runFailed", {
          time: failedAt,
          run: {
            id: runId,
            status: run.status,
            spanId: run.spanId,
            error,
          },
        });

        await this.#finalizeRun(run);

        return {
          attemptStatus: "RUN_FINISHED",
          snapshot: newSnapshot,
          run,
        };
      });
    });
  }

  //MARK: RunQueue

  /** The run can be added to the queue. When it's pulled from the queue it will be executed. */
  async #enqueueRun({
    run,
    env,
    timestamp,
    tx,
  }: {
    run: TaskRun;
    env: MinimalAuthenticatedEnvironment;
    timestamp: number;
    tx?: PrismaClientOrTransaction;
  }) {
    const prisma = tx ?? this.prisma;

    await this.runLock.lock([run.id], 5000, async (signal) => {
      const newSnapshot = await this.#createExecutionSnapshot(prisma, {
        run: run,
        snapshot: {
          executionStatus: "QUEUED",
          description: "Run was QUEUED",
        },
      });

      const masterQueues = [run.masterQueue];
      if (run.secondaryMasterQueue) {
        masterQueues.push(run.secondaryMasterQueue);
      }

      await this.runQueue.enqueueMessage({
        env,
        masterQueues,
        message: {
          runId: run.id,
          taskIdentifier: run.taskIdentifier,
          orgId: env.organization.id,
          projectId: env.project.id,
          environmentId: env.id,
          environmentType: env.type,
          queue: run.queue,
          concurrencyKey: run.concurrencyKey ?? undefined,
          timestamp,
          attempt: 0,
        },
      });
    });
  }

  async #tryNackAndRequeue({
    run,
    orgId,
    timestamp,
    error,
    tx,
  }: {
    run: TaskRun;
    orgId: string;
    timestamp?: number;
    error: TaskRunInternalError;
    tx?: PrismaClientOrTransaction;
  }): Promise<{ wasRequeued: boolean } & ExecutionResult> {
    const prisma = tx ?? this.prisma;

    return await this.runLock.lock([run.id], 5000, async (signal) => {
      //we nack the message, this allows another work to pick up the run
      const gotRequeued = await this.runQueue.nackMessage({
        orgId,
        messageId: run.id,
        retryAt: timestamp,
      });

      if (!gotRequeued) {
        const result = await this.#systemFailure({
          runId: run.id,
          error,
          tx: prisma,
        });
        return { wasRequeued: false, ...result };
      }

      const newSnapshot = await this.#createExecutionSnapshot(prisma, {
        run: run,
        snapshot: {
          executionStatus: "QUEUED",
          description: "Requeued the run after a failure",
        },
      });

      return {
        wasRequeued: true,
        snapshot: {
          id: newSnapshot.id,
          friendlyId: newSnapshot.friendlyId,
          executionStatus: newSnapshot.executionStatus,
          description: newSnapshot.description,
        },
        run: {
          id: newSnapshot.runId,
          friendlyId: newSnapshot.runFriendlyId,
          status: newSnapshot.runStatus,
          attemptNumber: newSnapshot.attemptNumber,
        },
      };
    });
  }

  async #continueRunIfUnblocked({ runId }: { runId: string }) {
    // 1. Get the any blocking waitpoints
    const blockingWaitpoints = await this.prisma.taskRunWaitpoint.findMany({
      where: { taskRunId: runId },
      select: {
        batchId: true,
        batchIndex: true,
        waitpoint: {
          select: { id: true, status: true },
        },
      },
    });

    // 2. There are blockers still, so do nothing
    if (blockingWaitpoints.some((w) => w.waitpoint.status !== "COMPLETED")) {
      return;
    }

    // 3. Get the run with environment
    const run = await this.prisma.taskRun.findFirst({
      where: {
        id: runId,
      },
      include: {
        runtimeEnvironment: {
          select: {
            id: true,
            type: true,
            maximumConcurrencyLimit: true,
            project: { select: { id: true } },
            organization: { select: { id: true } },
          },
        },
      },
    });

    if (!run) {
      throw new Error(`#continueRunIfUnblocked: run not found: ${runId}`);
    }

    //4. Continue the run whether it's executing or not
    await this.runLock.lock([runId], 5000, async (signal) => {
      const snapshot = await getLatestExecutionSnapshot(this.prisma, runId);

      //run is still executing, send a message to the worker
      if (isExecuting(snapshot.executionStatus)) {
        const newSnapshot = await this.#createExecutionSnapshot(this.prisma, {
          run: {
            id: runId,
            status: snapshot.runStatus,
            attemptNumber: snapshot.attemptNumber,
          },
          snapshot: {
            executionStatus: "EXECUTING",
            description: "Run was continued, whilst still executing.",
          },
          batchId: snapshot.batchId ?? undefined,
          completedWaitpoints: blockingWaitpoints.map((b) => ({
            id: b.waitpoint.id,
            index: b.batchIndex ?? undefined,
          })),
        });

        //we reacquire the concurrency if it's still running because we're not going to be dequeuing (which also does this)
        await this.runQueue.reacquireConcurrency(run.runtimeEnvironment.organization.id, runId);

        await this.#sendNotificationToWorker({ runId: runId });
      } else {
        const newSnapshot = await this.#createExecutionSnapshot(this.prisma, {
          run,
          snapshot: {
            executionStatus: "QUEUED",
            description: "Run is QUEUED, because all waitpoints are completed.",
          },
          batchId: snapshot.batchId ?? undefined,
          completedWaitpoints: blockingWaitpoints.map((b) => ({
            id: b.waitpoint.id,
            index: b.batchIndex ?? undefined,
          })),
        });

        //put it back in the queue, with the original timestamp (w/ priority)
        //this prioritizes dequeuing waiting runs over new runs
        await this.#enqueueRun({
          run,
          env: run.runtimeEnvironment,
          timestamp: run.createdAt.getTime() - run.priorityMs,
        });
      }
    });

    //5. Remove the blocking waitpoints
    await this.prisma.taskRunWaitpoint.deleteMany({
      where: {
        taskRunId: runId,
      },
    });
  }

  async #queueRunsWaitingForWorker({ backgroundWorkerId }: { backgroundWorkerId: string }) {
    //It could be a lot of runs, so we will process them in a batch
    //if there are still more to process we will enqueue this function again
    const maxCount = this.options.queueRunsWaitingForWorkerBatchSize ?? 200;

    const backgroundWorker = await this.prisma.backgroundWorker.findFirst({
      where: {
        id: backgroundWorkerId,
      },
      include: {
        runtimeEnvironment: {
          include: {
            project: true,
            organization: true,
          },
        },
        tasks: true,
      },
    });

    if (!backgroundWorker) {
      this.logger.error("#queueRunsWaitingForWorker: background worker not found", {
        id: backgroundWorkerId,
      });
      return;
    }

    const runsWaitingForDeploy = await this.prisma.taskRun.findMany({
      where: {
        runtimeEnvironmentId: backgroundWorker.runtimeEnvironmentId,
        projectId: backgroundWorker.projectId,
        status: "WAITING_FOR_DEPLOY",
        taskIdentifier: {
          in: backgroundWorker.tasks.map((task) => task.slug),
        },
      },
      orderBy: {
        createdAt: "asc",
      },
      take: maxCount + 1,
    });

    //none to process
    if (!runsWaitingForDeploy.length) return;

    for (const run of runsWaitingForDeploy) {
      await this.prisma.$transaction(async (tx) => {
        const updatedRun = await tx.taskRun.update({
          where: {
            id: run.id,
          },
          data: {
            status: "PENDING",
          },
        });
        await this.#enqueueRun({
          run: updatedRun,
          env: backgroundWorker.runtimeEnvironment,
          //add to the queue using the original run created time
          //this should ensure they're in the correct order in the queue
          timestamp: updatedRun.createdAt.getTime() - updatedRun.priorityMs,
          tx,
        });
      });
    }

    //enqueue more if needed
    if (runsWaitingForDeploy.length > maxCount) {
      await this.queueRunsWaitingForWorker({ backgroundWorkerId });
    }
  }

  //MARK: - Waitpoints
  async #createRunAssociatedWaitpoint(
    tx: PrismaClientOrTransaction,
    {
      projectId,
      environmentId,
      completedByTaskRunId,
    }: { projectId: string; environmentId: string; completedByTaskRunId: string }
  ) {
    return tx.waitpoint.create({
      data: {
        ...WaitpointId.generate(),
        type: "RUN",
        status: "PENDING",
        idempotencyKey: nanoid(24),
        userProvidedIdempotencyKey: false,
        projectId,
        environmentId,
        completedByTaskRunId,
      },
    });
  }

  async #createDateTimeWaitpoint(
    tx: PrismaClientOrTransaction,
    {
      projectId,
      environmentId,
      completedAfter,
      idempotencyKey,
    }: { projectId: string; environmentId: string; completedAfter: Date; idempotencyKey?: string }
  ) {
    const waitpoint = await tx.waitpoint.create({
      data: {
        ...WaitpointId.generate(),
        type: "DATETIME",
        status: "PENDING",
        idempotencyKey: idempotencyKey ?? nanoid(24),
        userProvidedIdempotencyKey: !!idempotencyKey,
        projectId,
        environmentId,
        completedAfter,
      },
    });

    await this.worker.enqueue({
      id: `finishWaitpoint.${waitpoint.id}`,
      job: "finishWaitpoint",
      payload: { waitpointId: waitpoint.id },
      availableAt: completedAfter,
    });

    return waitpoint;
  }

  async #rescheduleDateTimeWaitpoint(
    tx: PrismaClientOrTransaction,
    waitpointId: string,
    completedAfter: Date
  ): Promise<{ success: true } | { success: false; error: string }> {
    try {
      const updatedWaitpoint = await tx.waitpoint.update({
        where: { id: waitpointId, status: "PENDING" },
        data: {
          completedAfter,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        return {
          success: false,
          error: "Waitpoint doesn't exist or is already completed",
        };
      }

      this.logger.error("Error rescheduling waitpoint", { error });

      return {
        success: false,
        error: "An unknown error occurred",
      };
    }

    //reschedule completion
    await this.worker.enqueue({
      id: `finishWaitpoint.${waitpointId}`,
      job: "finishWaitpoint",
      payload: { waitpointId: waitpointId },
      availableAt: completedAfter,
    });

    return {
      success: true,
    };
  }

  async #clearBlockingWaitpoints({ runId, tx }: { runId: string; tx?: PrismaClientOrTransaction }) {
    const prisma = tx ?? this.prisma;
    const deleted = await prisma.taskRunWaitpoint.deleteMany({
      where: {
        taskRunId: runId,
      },
    });

    return deleted.count;
  }

  //#region TaskRunExecutionSnapshots
  async #createExecutionSnapshot(
    prisma: PrismaClientOrTransaction,
    {
      run,
      snapshot,
      batchId,
      checkpointId,
      completedWaitpoints,
      error,
    }: {
      run: { id: string; status: TaskRunStatus; attemptNumber?: number | null };
      snapshot: {
        executionStatus: TaskRunExecutionStatus;
        description: string;
      };
      batchId?: string;
      checkpointId?: string;
      completedWaitpoints?: {
        id: string;
        index?: number;
      }[];
      error?: string;
    }
  ) {
    const newSnapshot = await prisma.taskRunExecutionSnapshot.create({
      data: {
        engine: "V2",
        executionStatus: snapshot.executionStatus,
        description: snapshot.description,
        runId: run.id,
        runStatus: run.status,
        attemptNumber: run.attemptNumber ?? undefined,
        batchId,
        checkpointId,
        completedWaitpoints: {
          connect: completedWaitpoints?.map((w) => ({ id: w.id })),
        },
        completedWaitpointOrder: completedWaitpoints
          ?.filter((c) => c.index !== undefined)
          .sort((a, b) => a.index! - b.index!)
          .map((w) => w.id),
        isValid: error ? false : true,
        error,
      },
      include: {
        checkpoint: true,
      },
    });

    if (!error) {
      //set heartbeat (if relevant)
      await this.#setExecutionSnapshotHeartbeat({
        status: newSnapshot.executionStatus,
        runId: run.id,
        snapshotId: newSnapshot.id,
      });
    }

    this.eventBus.emit("executionSnapshotCreated", {
      time: newSnapshot.createdAt,
      run: {
        id: newSnapshot.runId,
      },
      snapshot: {
        ...newSnapshot,
        completedWaitpointIds: completedWaitpoints?.map((w) => w.id) ?? [],
      },
    });

    return {
      ...newSnapshot,
      friendlyId: SnapshotId.toFriendlyId(newSnapshot.id),
      runFriendlyId: RunId.toFriendlyId(newSnapshot.runId),
    };
  }

  async #setExecutionSnapshotHeartbeat({
    status,
    runId,
    snapshotId,
  }: {
    status: TaskRunExecutionStatus;
    runId: string;
    snapshotId: string;
  }) {
    await this.#setHeartbeatDeadline({
      runId,
      snapshotId,
      status,
    });
  }

  #getHeartbeatIntervalMs(status: TaskRunExecutionStatus): number | null {
    switch (status) {
      case "PENDING_EXECUTING": {
        return this.heartbeatTimeouts.PENDING_EXECUTING;
      }
      case "PENDING_CANCEL": {
        return this.heartbeatTimeouts.PENDING_CANCEL;
      }
      case "EXECUTING": {
        return this.heartbeatTimeouts.EXECUTING;
      }
      case "EXECUTING_WITH_WAITPOINTS": {
        return this.heartbeatTimeouts.EXECUTING_WITH_WAITPOINTS;
      }
      default: {
        return null;
      }
    }
  }

  //#endregion

  //#region Heartbeat
  async #setHeartbeatDeadline({
    runId,
    snapshotId,
    status,
  }: {
    runId: string;
    snapshotId: string;
    status: TaskRunExecutionStatus;
  }) {
    const intervalMs = this.#getHeartbeatIntervalMs(status);

    if (intervalMs === null) {
      return;
    }

    await this.worker.enqueue({
      id: `heartbeatSnapshot.${snapshotId}`,
      job: "heartbeatSnapshot",
      payload: { snapshotId, runId },
      availableAt: new Date(Date.now() + intervalMs),
    });
  }

  async #handleStalledSnapshot({
    runId,
    snapshotId,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    tx?: PrismaClientOrTransaction;
  }) {
    const prisma = tx ?? this.prisma;
    return await this.runLock.lock([runId], 5_000, async (signal) => {
      const latestSnapshot = await getLatestExecutionSnapshot(prisma, runId);
      if (latestSnapshot.id !== snapshotId) {
        this.logger.log(
          "RunEngine.#handleStalledSnapshot() no longer the latest snapshot, stopping the heartbeat.",
          {
            runId,
            snapshotId,
            latestSnapshot: latestSnapshot,
          }
        );

        await this.worker.ack(`heartbeatSnapshot.${snapshotId}`);
        return;
      }

      this.logger.log("RunEngine.#handleStalledSnapshot() handling stalled snapshot", {
        runId,
        snapshot: latestSnapshot,
      });

      switch (latestSnapshot.executionStatus) {
        case "RUN_CREATED": {
          throw new NotImplementedError("There shouldn't be a heartbeat for RUN_CREATED");
        }
        case "QUEUED": {
          throw new NotImplementedError("There shouldn't be a heartbeat for QUEUED");
        }
        case "PENDING_EXECUTING": {
          //the run didn't start executing, we need to requeue it
          const run = await prisma.taskRun.findFirst({
            where: { id: runId },
            include: {
              runtimeEnvironment: {
                include: {
                  organization: true,
                },
              },
            },
          });

          if (!run) {
            this.logger.error(
              "RunEngine.#handleStalledSnapshot() PENDING_EXECUTING run not found",
              {
                runId,
                snapshot: latestSnapshot,
              }
            );

            throw new Error(`Run ${runId} not found`);
          }

          //it will automatically be requeued X times depending on the queue retry settings
          const gotRequeued = await this.#tryNackAndRequeue({
            run,
            orgId: run.runtimeEnvironment.organizationId,
            error: {
              type: "INTERNAL_ERROR",
              code: "TASK_RUN_DEQUEUED_MAX_RETRIES",
              message: `Trying to create an attempt failed multiple times, exceeding how many times we retry.`,
            },
            tx: prisma,
          });
          break;
        }
        case "EXECUTING":
        case "EXECUTING_WITH_WAITPOINTS": {
          const retryDelay = 250;

          //todo call attemptFailed and force requeuing
          await this.#attemptFailed({
            runId,
            snapshotId: latestSnapshot.id,
            completion: {
              ok: false,
              id: runId,
              error: {
                type: "INTERNAL_ERROR",
                code:
                  latestSnapshot.executionStatus === "EXECUTING"
                    ? "TASK_RUN_STALLED_EXECUTING"
                    : "TASK_RUN_STALLED_EXECUTING_WITH_WAITPOINTS",
                message: `Trying to create an attempt failed multiple times, exceeding how many times we retry.`,
              },
              retry: {
                //250ms in the future
                timestamp: Date.now() + retryDelay,
                delay: retryDelay,
              },
            },
            forceRequeue: true,
            tx: prisma,
          });
          break;
        }
        case "SUSPENDED": {
          //todo should we do a periodic check here for whether waitpoints are actually still blocking?
          //we could at least log some things out if a run has been in this state for a long time
          throw new NotImplementedError("Not implemented SUSPENDED");
        }
        case "PENDING_CANCEL": {
          //if the run is waiting to cancel but the worker hasn't confirmed that,
          //we force the run to be cancelled
          await this.cancelRun({
            runId: latestSnapshot.runId,
            finalizeRun: true,
            tx,
          });
          break;
        }
        case "FINISHED": {
          throw new NotImplementedError("There shouldn't be a heartbeat for FINISHED");
        }
        default: {
          assertNever(latestSnapshot.executionStatus);
        }
      }
    });
  }

  //#endregion

  /**
   * Sends a notification that a run has changed and we need to fetch the latest run state.
   * The worker will call `getRunExecutionData` via the API and act accordingly.
   */
  async #sendNotificationToWorker({ runId }: { runId: string }) {
    this.eventBus.emit("workerNotification", { time: new Date(), run: { id: runId } });
  }

  /*
   * Whether the run succeeds, fails, is cancelled… we need to run these operations
   */
  async #finalizeRun({ id, batchId }: { id: string; batchId: string | null }) {
    if (batchId) {
      await this.tryCompleteBatch({ batchId });
    }
  }

  /**
   * Checks to see if all runs for a BatchTaskRun are completed, if they are then update the status.
   * This isn't used operationally, but it's used for the Batches dashboard page.
   */
  async #tryCompleteBatch({ batchId }: { batchId: string }) {
    return this.#trace(
      "#tryCompleteBatch",
      {
        batchId,
      },
      async (span) => {
        const batch = await this.prisma.batchTaskRun.findUnique({
          select: {
            status: true,
            runtimeEnvironmentId: true,
          },
          where: {
            id: batchId,
          },
        });

        if (!batch) {
          this.logger.error("#tryCompleteBatch batch doesn't exist", { batchId });
          return;
        }

        if (batch.status === "COMPLETED") {
          this.logger.debug("#tryCompleteBatch: Batch already completed", { batchId });
          return;
        }

        const runs = await this.prisma.taskRun.findMany({
          select: {
            id: true,
            status: true,
          },
          where: {
            batchId,
            runtimeEnvironmentId: batch.runtimeEnvironmentId,
          },
        });

        if (runs.every((r) => isFinalRunStatus(r.status))) {
          this.logger.debug("#tryCompleteBatch: All runs are completed", { batchId });
          await this.prisma.batchTaskRun.update({
            where: {
              id: batchId,
            },
            data: {
              status: "COMPLETED",
            },
          });
        } else {
          this.logger.debug("#tryCompleteBatch: Not all runs are completed", { batchId });
        }
      }
    );
  }

  async #getAuthenticatedEnvironmentFromRun(runId: string, tx?: PrismaClientOrTransaction) {
    const prisma = tx ?? this.prisma;
    const taskRun = await prisma.taskRun.findUnique({
      where: {
        id: runId,
      },
      include: {
        runtimeEnvironment: {
          include: {
            organization: true,
            project: true,
          },
        },
      },
    });

    if (!taskRun) {
      return;
    }

    return taskRun?.runtimeEnvironment;
  }

  #environmentMasterQueueKey(environmentId: string) {
    return `master-env:${environmentId}`;
  }

  #backgroundWorkerQueueKey(backgroundWorkerId: string) {
    return `master-background-worker:${backgroundWorkerId}`;
  }

  async #trace<T>(
    trace: string,
    attributes: Attributes | undefined,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    return this.tracer.startActiveSpan(
      `${this.constructor.name}.${trace}`,
      { attributes, kind: SpanKind.SERVER },
      async (span) => {
        try {
          return await fn(span);
        } catch (e) {
          if (e instanceof ServiceValidationError) {
            throw e;
          }

          if (e instanceof Error) {
            span.recordException(e);
          } else {
            span.recordException(new Error(String(e)));
          }

          throw e;
        } finally {
          span.end();
        }
      }
    );
  }
}

export class ServiceValidationError extends Error {
  constructor(
    message: string,
    public status?: number
  ) {
    super(message);
    this.name = "ServiceValidationError";
  }
}

class NotImplementedError extends Error {
  constructor(message: string) {
    console.error("This isn't implemented", { message });
    super(message);
  }
}

export class RunDuplicateIdempotencyKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunDuplicateIdempotencyKeyError";
  }
}
