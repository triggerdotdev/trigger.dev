import { createRedisClient, Redis } from "@internal/redis";
import { Worker } from "@internal/redis-worker";
import { startSpan, trace, Tracer } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import {
  CheckpointInput,
  CompleteRunAttemptResult,
  CreateCheckpointResult,
  DequeuedMessage,
  ExecutionResult,
  MachineResources,
  parsePacket,
  RunExecutionData,
  StartRunAttemptResult,
  TaskRunError,
  TaskRunExecution,
  TaskRunExecutionResult,
  timeoutError,
} from "@trigger.dev/core/v3";
import {
  BatchId,
  CheckpointId,
  parseNaturalLanguageDuration,
  QueueId,
  RunId,
  WaitpointId,
} from "@trigger.dev/core/v3/isomorphic";
import {
  $transaction,
  Prisma,
  PrismaClient,
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunExecutionSnapshot,
  TaskRunExecutionStatus,
  Waitpoint,
} from "@trigger.dev/database";
import { assertNever } from "assert-never";
import { nanoid } from "nanoid";
import { EventEmitter } from "node:events";
import { FairQueueSelectionStrategy } from "../run-queue/fairQueueSelectionStrategy.js";
import { RunQueue } from "../run-queue/index.js";
import { RunQueueFullKeyProducer } from "../run-queue/keyProducer.js";
import { MinimalAuthenticatedEnvironment } from "../shared/index.js";
import { MAX_TASK_RUN_ATTEMPTS } from "./consts.js";
import { EventBus, EventBusEvents, sendNotificationToWorker } from "./eventBus.js";
import { RunLocker } from "./locking.js";
import { getMachinePreset } from "./machinePresets.js";
import { ReleaseConcurrencyTokenBucketQueue } from "./releaseConcurrencyTokenBucketQueue.js";
import {
  canReleaseConcurrency,
  isCheckpointable,
  isExecuting,
  isPendingExecuting,
} from "./statuses.js";
import { BatchSystem } from "./systems/batchSystem.js";
import { DequeueSystem } from "./systems/dequeueSystem.js";
import {
  executionResultFromSnapshot,
  ExecutionSnapshotSystem,
  getLatestExecutionSnapshot,
} from "./systems/executionSnapshotSystem.js";
import { RunAttemptSystem } from "./systems/runAttemptSystem.js";
import { WaitpointSystem } from "./systems/waitpointSystem.js";
import { EngineWorker, HeartbeatTimeouts, RunEngineOptions, TriggerParams } from "./types.js";
import { workerCatalog } from "./workerCatalog.js";

export class RunEngine {
  private runLockRedis: Redis;
  private prisma: PrismaClient;
  private runLock: RunLocker;
  runQueue: RunQueue;
  private worker: EngineWorker;
  private logger = new Logger("RunEngine", "debug");
  private tracer: Tracer;
  private heartbeatTimeouts: HeartbeatTimeouts;
  private releaseConcurrencyQueue: ReleaseConcurrencyTokenBucketQueue<{
    orgId: string;
    projectId: string;
    envId: string;
  }>;
  eventBus: EventBus = new EventEmitter<EventBusEvents>();
  executionSnapshotSystem: ExecutionSnapshotSystem;
  runAttemptSystem: RunAttemptSystem;
  dequeueSystem: DequeueSystem;
  waitpointSystem: WaitpointSystem;
  batchSystem: BatchSystem;

  constructor(private readonly options: RunEngineOptions) {
    this.prisma = options.prisma;
    this.runLockRedis = createRedisClient(
      {
        ...options.runLock.redis,
        keyPrefix: `${options.runLock.redis.keyPrefix}runlock:`,
      },
      {
        onError: (error) => {
          this.logger.error(`RunLock redis client error:`, {
            error,
            keyPrefix: options.runLock.redis.keyPrefix,
          });
        },
      }
    );
    this.runLock = new RunLocker({ redis: this.runLockRedis });

    const keys = new RunQueueFullKeyProducer();

    this.runQueue = new RunQueue({
      name: "rq",
      tracer: trace.getTracer("rq"),
      keys,
      queueSelectionStrategy: new FairQueueSelectionStrategy({
        keys,
        redis: { ...options.queue.redis, keyPrefix: `${options.queue.redis.keyPrefix}runqueue:` },
        defaultEnvConcurrencyLimit: options.queue?.defaultEnvConcurrency ?? 10,
      }),
      defaultEnvConcurrency: options.queue?.defaultEnvConcurrency ?? 10,
      logger: new Logger("RunQueue", "debug"),
      redis: { ...options.queue.redis, keyPrefix: `${options.queue.redis.keyPrefix}runqueue:` },
      retryOptions: options.queue?.retryOptions,
    });

    this.worker = new Worker({
      name: "worker",
      redisOptions: {
        ...options.worker.redis,
        keyPrefix: `${options.worker.redis.keyPrefix}worker:`,
      },
      catalog: workerCatalog,
      concurrency: options.worker,
      pollIntervalMs: options.worker.pollIntervalMs,
      immediatePollIntervalMs: options.worker.immediatePollIntervalMs,
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
          await this.runAttemptSystem.cancelRun({
            runId: payload.runId,
            completedAt: payload.completedAt,
            reason: payload.reason,
          });
        },
        queueRunsWaitingForWorker: async ({ payload }) => {
          await this.#queueRunsWaitingForWorker({ backgroundWorkerId: payload.backgroundWorkerId });
        },
        tryCompleteBatch: async ({ payload }) => {
          await this.batchSystem.performCompleteBatch({ batchId: payload.batchId });
        },
        continueRunIfUnblocked: async ({ payload }) => {
          await this.#continueRunIfUnblocked({
            runId: payload.runId,
          });
        },
        enqueueDelayedRun: async ({ payload }) => {
          await this.#enqueueDelayedRun({ runId: payload.runId });
        },
      },
    }).start();

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

    // Initialize the ReleaseConcurrencyQueue
    this.releaseConcurrencyQueue = new ReleaseConcurrencyTokenBucketQueue({
      redis: {
        ...options.queue.redis, // Use base queue redis options
        ...options.releaseConcurrency?.redis, // Allow overrides
        keyPrefix: `${options.queue.redis.keyPrefix}release-concurrency:`,
      },
      retry: {
        maxRetries: options.releaseConcurrency?.maxRetries ?? 5,
        backoff: {
          minDelay: options.releaseConcurrency?.backoff?.minDelay ?? 1000,
          maxDelay: options.releaseConcurrency?.backoff?.maxDelay ?? 10000,
          factor: options.releaseConcurrency?.backoff?.factor ?? 2,
        },
      },
      consumersCount: options.releaseConcurrency?.consumersCount ?? 1,
      pollInterval: options.releaseConcurrency?.pollInterval ?? 1000,
      batchSize: options.releaseConcurrency?.batchSize ?? 10,
      executor: async (descriptor, runId) => {
        await this.#executeReleasedConcurrencyFromQueue(descriptor, runId);
      },
      maxTokens: async (descriptor) => {
        const environment = await this.prisma.runtimeEnvironment.findFirstOrThrow({
          where: { id: descriptor.envId },
          select: {
            maximumConcurrencyLimit: true,
          },
        });

        return (
          environment.maximumConcurrencyLimit * (options.releaseConcurrency?.maxTokensRatio ?? 1.0)
        );
      },
      keys: {
        fromDescriptor: (descriptor) =>
          `org:${descriptor.orgId}:proj:${descriptor.projectId}:env:${descriptor.envId}`,
        toDescriptor: (name) => ({
          orgId: name.split(":")[1],
          projectId: name.split(":")[3],
          envId: name.split(":")[5],
        }),
      },
      tracer: this.tracer,
    });

    this.executionSnapshotSystem = new ExecutionSnapshotSystem({
      worker: this.worker,
      eventBus: this.eventBus,
      heartbeatTimeouts: this.heartbeatTimeouts,
      prisma: this.prisma,
      logger: this.logger,
      tracer: this.tracer,
    });

    this.waitpointSystem = new WaitpointSystem({
      prisma: this.prisma,
      worker: this.worker,
      eventBus: this.eventBus,
      logger: this.logger,
      tracer: this.tracer,
    });

    this.batchSystem = new BatchSystem({
      prisma: this.prisma,
      logger: this.logger,
      tracer: this.tracer,
      worker: this.worker,
    });

    this.runAttemptSystem = new RunAttemptSystem({
      prisma: this.prisma,
      logger: this.logger,
      tracer: this.tracer,
      runLock: this.runLock,
      eventBus: this.eventBus,
      runQueue: this.runQueue,
      worker: this.worker,
      executionSnapshotSystem: this.executionSnapshotSystem,
      batchSystem: this.batchSystem,
      waitpointSystem: this.waitpointSystem,
      machines: this.options.machines,
    });

    this.dequeueSystem = new DequeueSystem({
      prisma: this.prisma,
      queue: this.runQueue,
      runLock: this.runLock,
      logger: this.logger,
      machines: this.options.machines,
      tracer: this.tracer,
      executionSnapshotSystem: this.executionSnapshotSystem,
      runAttemptSystem: this.runAttemptSystem,
    });
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
      taskEventStore,
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
      workerId,
      runnerId,
    }: TriggerParams,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    const prisma = tx ?? this.prisma;

    return startSpan(
      this.tracer,
      "trigger",
      async (span) => {
        const status = delayUntil ? "DELAYED" : "PENDING";

        let secondaryMasterQueue: string | undefined = undefined;

        if (environment.type === "DEVELOPMENT") {
          // In dev we use the environment id as the master queue, or the locked worker id
          masterQueue = this.#environmentMasterQueueKey(environment.id);
          if (lockedToVersionId) {
            masterQueue = this.#backgroundWorkerQueueKey(lockedToVersionId);
          }
        } else {
          // For deployed runs, we add the env/worker id as the secondary master queue
          let secondaryMasterQueue = this.#environmentMasterQueueKey(environment.id);
          if (lockedToVersionId) {
            secondaryMasterQueue = this.#backgroundWorkerQueueKey(lockedToVersionId);
          }
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
              taskEventStore,
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
                  environmentId: environment.id,
                  environmentType: environment.type,
                  workerId,
                  runnerId,
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
              organizationId: environment.organization.id,
              batch,
              workerId,
              runnerId,
              tx: prisma,
              releaseConcurrency: true, // TODO: This needs to use the release concurrency system
            });
          }

          //Make sure lock extension succeeded
          signal.throwIfAborted();

          if (queue) {
            const concurrencyLimit =
              typeof queue.concurrencyLimit === "number"
                ? Math.max(Math.min(queue.concurrencyLimit, environment.maximumConcurrencyLimit), 0)
                : queue.concurrencyLimit;

            let taskQueue = await prisma.taskQueue.findFirst({
              where: {
                runtimeEnvironmentId: environment.id,
                name: queueName,
              },
            });

            if (!taskQueue) {
              // handle conflicts with existing queues
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
            }

            if (typeof concurrencyLimit === "number") {
              this.logger.debug("TriggerTaskService: updating concurrency limit", {
                runId: taskRun.id,
                friendlyId: taskRun.friendlyId,
                taskQueue,
                orgId: environment.organization.id,
                projectId: environment.project.id,
                concurrencyLimit,
                queueOptions: queue,
              });

              await this.runQueue.updateQueueConcurrencyLimits(
                environment,
                taskQueue.name,
                concurrencyLimit
              );
            } else if (concurrencyLimit === null) {
              this.logger.debug("TriggerTaskService: removing concurrency limit", {
                runId: taskRun.id,
                friendlyId: taskRun.friendlyId,
                taskQueue,
                orgId: environment.organization.id,
                projectId: environment.project.id,
                queueOptions: queue,
              });

              await this.runQueue.removeQueueConcurrencyLimits(environment, taskQueue.name);
            }
          }

          //Make sure lock extension succeeded
          signal.throwIfAborted();

          if (taskRun.delayUntil) {
            // Schedule the run to be enqueued at the delayUntil time
            await this.worker.enqueue({
              id: `enqueueDelayedRun:${taskRun.id}`,
              job: "enqueueDelayedRun",
              payload: { runId: taskRun.id },
              availableAt: taskRun.delayUntil,
            });
          } else {
            await this.#enqueueRun({
              run: taskRun,
              env: environment,
              timestamp: Date.now() - taskRun.priorityMs,
              workerId,
              runnerId,
              tx: prisma,
            });

            if (taskRun.ttl) {
              const expireAt = parseNaturalLanguageDuration(taskRun.ttl);

              if (expireAt) {
                await this.worker.enqueue({
                  id: `expireRun:${taskRun.id}`,
                  job: "expireRun",
                  payload: { runId: taskRun.id },
                  availableAt: expireAt,
                });
              }
            }
          }
        });

        return taskRun;
      },
      {
        attributes: {
          friendlyId,
          environmentId: environment.id,
          projectId: environment.project.id,
          taskIdentifier,
        },
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
    workerId,
    runnerId,
    tx,
  }: {
    consumerId: string;
    masterQueue: string;
    maxRunCount: number;
    maxResources?: MachineResources;
    backgroundWorkerId?: string;
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<DequeuedMessage[]> {
    return this.dequeueSystem.dequeueFromMasterQueue({
      consumerId,
      masterQueue,
      maxRunCount,
      maxResources,
      backgroundWorkerId,
      workerId,
      runnerId,
      tx,
    });
  }

  async dequeueFromEnvironmentMasterQueue({
    consumerId,
    environmentId,
    maxRunCount,
    maxResources,
    backgroundWorkerId,
    workerId,
    runnerId,
    tx,
  }: {
    consumerId: string;
    environmentId: string;
    maxRunCount: number;
    maxResources?: MachineResources;
    backgroundWorkerId?: string;
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<DequeuedMessage[]> {
    return this.dequeueFromMasterQueue({
      consumerId,
      masterQueue: this.#environmentMasterQueueKey(environmentId),
      maxRunCount,
      maxResources,
      backgroundWorkerId,
      workerId,
      runnerId,
      tx,
    });
  }

  async dequeueFromBackgroundWorkerMasterQueue({
    consumerId,
    backgroundWorkerId,
    maxRunCount,
    maxResources,
    workerId,
    runnerId,
    tx,
  }: {
    consumerId: string;
    backgroundWorkerId: string;
    maxRunCount: number;
    maxResources?: MachineResources;
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<DequeuedMessage[]> {
    return this.dequeueFromMasterQueue({
      consumerId,
      masterQueue: this.#backgroundWorkerQueueKey(backgroundWorkerId),
      maxRunCount,
      maxResources,
      backgroundWorkerId,
      workerId,
      runnerId,
      tx,
    });
  }

  async startRunAttempt({
    runId,
    snapshotId,
    workerId,
    runnerId,
    isWarmStart,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    workerId?: string;
    runnerId?: string;
    isWarmStart?: boolean;
    tx?: PrismaClientOrTransaction;
  }): Promise<StartRunAttemptResult> {
    return this.runAttemptSystem.startRunAttempt({
      runId,
      snapshotId,
      workerId,
      runnerId,
      isWarmStart,
      tx,
    });
  }

  /** How a run is completed */
  async completeRunAttempt({
    runId,
    snapshotId,
    completion,
    workerId,
    runnerId,
  }: {
    runId: string;
    snapshotId: string;
    completion: TaskRunExecutionResult;
    workerId?: string;
    runnerId?: string;
  }): Promise<CompleteRunAttemptResult> {
    return this.runAttemptSystem.completeRunAttempt({
      runId,
      snapshotId,
      completion,
      workerId,
      runnerId,
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
    workerId,
    runnerId,
    completedAt,
    reason,
    finalizeRun,
    tx,
  }: {
    runId: string;
    workerId?: string;
    runnerId?: string;
    completedAt?: Date;
    reason?: string;
    finalizeRun?: boolean;
    tx?: PrismaClientOrTransaction;
  }): Promise<ExecutionResult> {
    return this.runAttemptSystem.cancelRun({
      runId,
      workerId,
      runnerId,
      completedAt,
      reason,
      finalizeRun,
      tx,
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
  async rescheduleDelayedRun({
    runId,
    delayUntil,
    tx,
  }: {
    runId: string;
    delayUntil: Date;
    tx?: PrismaClientOrTransaction;
  }): Promise<TaskRun> {
    const prisma = tx ?? this.prisma;
    return startSpan(
      this.tracer,
      "rescheduleRun",
      async (span) => {
        return await this.runLock.lock([runId], 5_000, async () => {
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
                  environmentId: snapshot.environmentId,
                  environmentType: snapshot.environmentType,
                },
              },
            },
          });

          await this.worker.reschedule(`enqueueDelayedRun:${updatedRun.id}`, delayUntil);

          return updatedRun;
        });
      },
      {
        attributes: { runId },
      }
    );
  }

  async lengthOfEnvQueue(environment: MinimalAuthenticatedEnvironment): Promise<number> {
    return this.runQueue.lengthOfEnvQueue(environment);
  }

  async concurrencyOfEnvQueue(environment: MinimalAuthenticatedEnvironment): Promise<number> {
    return this.runQueue.currentConcurrencyOfEnvironment(environment);
  }

  async lengthOfQueues(
    environment: MinimalAuthenticatedEnvironment,
    queues: string[]
  ): Promise<Record<string, number>> {
    return this.runQueue.lengthOfQueues(environment, queues);
  }

  async currentConcurrencyOfQueues(
    environment: MinimalAuthenticatedEnvironment,
    queues: string[]
  ): Promise<Record<string, number>> {
    return this.runQueue.currentConcurrencyOfQueues(environment, queues);
  }

  /**
   * This creates a DATETIME waitpoint, that will be completed automatically when the specified date is reached.
   * If you pass an `idempotencyKey`, the waitpoint will be created only if it doesn't already exist.
   */
  async createDateTimeWaitpoint({
    projectId,
    environmentId,
    completedAfter,
    idempotencyKey,
    idempotencyKeyExpiresAt,
    tx,
  }: {
    projectId: string;
    environmentId: string;
    completedAfter: Date;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
    tx?: PrismaClientOrTransaction;
  }) {
    const prisma = tx ?? this.prisma;

    const existingWaitpoint = idempotencyKey
      ? await prisma.waitpoint.findUnique({
          where: {
            environmentId_idempotencyKey: {
              environmentId,
              idempotencyKey,
            },
          },
        })
      : undefined;

    if (existingWaitpoint) {
      if (
        existingWaitpoint.idempotencyKeyExpiresAt &&
        new Date() > existingWaitpoint.idempotencyKeyExpiresAt
      ) {
        //the idempotency key has expired
        //remove the waitpoint idempotencyKey
        await prisma.waitpoint.update({
          where: {
            id: existingWaitpoint.id,
          },
          data: {
            idempotencyKey: nanoid(24),
            inactiveIdempotencyKey: existingWaitpoint.idempotencyKey,
          },
        });

        //let it fall through to create a new waitpoint
      } else {
        return { waitpoint: existingWaitpoint, isCached: true };
      }
    }

    const waitpoint = await prisma.waitpoint.upsert({
      where: {
        environmentId_idempotencyKey: {
          environmentId,
          idempotencyKey: idempotencyKey ?? nanoid(24),
        },
      },
      create: {
        ...WaitpointId.generate(),
        type: "DATETIME",
        idempotencyKey: idempotencyKey ?? nanoid(24),
        idempotencyKeyExpiresAt,
        userProvidedIdempotencyKey: !!idempotencyKey,
        environmentId,
        projectId,
        completedAfter,
      },
      update: {},
    });

    await this.worker.enqueue({
      id: `finishWaitpoint.${waitpoint.id}`,
      job: "finishWaitpoint",
      payload: { waitpointId: waitpoint.id },
      availableAt: completedAfter,
    });

    return { waitpoint, isCached: false };
  }

  /** This creates a MANUAL waitpoint, that can be explicitly completed (or failed).
   * If you pass an `idempotencyKey` and it already exists, it will return the existing waitpoint.
   */
  async createManualWaitpoint({
    environmentId,
    projectId,
    idempotencyKey,
    idempotencyKeyExpiresAt,
    timeout,
  }: {
    environmentId: string;
    projectId: string;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
    timeout?: Date;
  }): Promise<{ waitpoint: Waitpoint; isCached: boolean }> {
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
      if (
        existingWaitpoint.idempotencyKeyExpiresAt &&
        new Date() > existingWaitpoint.idempotencyKeyExpiresAt
      ) {
        //the idempotency key has expired
        //remove the waitpoint idempotencyKey
        await this.prisma.waitpoint.update({
          where: {
            id: existingWaitpoint.id,
          },
          data: {
            idempotencyKey: nanoid(24),
            inactiveIdempotencyKey: existingWaitpoint.idempotencyKey,
          },
        });

        //let it fall through to create a new waitpoint
      } else {
        return { waitpoint: existingWaitpoint, isCached: true };
      }
    }

    const waitpoint = await this.prisma.waitpoint.upsert({
      where: {
        environmentId_idempotencyKey: {
          environmentId,
          idempotencyKey: idempotencyKey ?? nanoid(24),
        },
      },
      create: {
        ...WaitpointId.generate(),
        type: "MANUAL",
        idempotencyKey: idempotencyKey ?? nanoid(24),
        idempotencyKeyExpiresAt,
        userProvidedIdempotencyKey: !!idempotencyKey,
        environmentId,
        projectId,
        completedAfter: timeout,
      },
      update: {},
    });

    //schedule the timeout
    if (timeout) {
      await this.worker.enqueue({
        id: `finishWaitpoint.${waitpoint.id}`,
        job: "finishWaitpoint",
        payload: {
          waitpointId: waitpoint.id,
          error: JSON.stringify(timeoutError(timeout)),
        },
        availableAt: timeout,
      });
    }

    return { waitpoint, isCached: false };
  }

  /** This block a run with a BATCH waitpoint.
   * The waitpoint will be created, and it will block the parent run.
   */
  async blockRunWithCreatedBatch({
    runId,
    batchId,
    environmentId,
    projectId,
    organizationId,
    tx,
  }: {
    runId: string;
    batchId: string;
    environmentId: string;
    projectId: string;
    organizationId: string;
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
        organizationId,
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
    return this.batchSystem.scheduleCompleteBatch({ batchId });
  }

  async getWaitpoint({
    waitpointId,
    environmentId,
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
    organizationId,
    releaseConcurrency,
    timeout,
    spanIdToComplete,
    batch,
    workerId,
    runnerId,
    tx,
  }: {
    runId: string;
    waitpoints: string | string[];
    environmentId: string;
    projectId: string;
    organizationId: string;
    releaseConcurrency?: boolean;
    timeout?: Date;
    spanIdToComplete?: string;
    batch?: { id: string; index?: number };
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<TaskRunExecutionSnapshot> {
    const prisma = tx ?? this.prisma;

    let $waitpoints = typeof waitpoints === "string" ? [waitpoints] : waitpoints;

    return await this.runLock.lock([runId], 5000, async () => {
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
        snapshot = await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
          run: {
            id: snapshot.runId,
            status: snapshot.runStatus,
            attemptNumber: snapshot.attemptNumber,
          },
          snapshot: {
            executionStatus: newStatus,
            description: "Run was blocked by a waitpoint.",
          },
          environmentId: snapshot.environmentId,
          environmentType: snapshot.environmentType,
          batchId: batch?.id ?? snapshot.batchId ?? undefined,
          workerId,
          runnerId,
        });

        // Let the worker know immediately, so it can suspend the run
        await sendNotificationToWorker({ runId, snapshot, eventBus: this.eventBus });
      }

      if (timeout) {
        for (const waitpoint of $waitpoints) {
          await this.worker.enqueue({
            id: `finishWaitpoint.${waitpoint}`,
            job: "finishWaitpoint",
            payload: {
              waitpointId: waitpoint,
              error: JSON.stringify(timeoutError(timeout)),
            },
            availableAt: timeout,
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
          //in the near future
          availableAt: new Date(Date.now() + 50),
        });
      } else {
        if (releaseConcurrency) {
          //release concurrency
          await this.#attemptToReleaseConcurrency(organizationId, snapshot);
        }
      }

      return snapshot;
    });
  }

  async #attemptToReleaseConcurrency(orgId: string, snapshot: TaskRunExecutionSnapshot) {
    // Go ahead and release concurrency immediately if the run is in a development environment
    if (snapshot.environmentType === "DEVELOPMENT") {
      return await this.runQueue.releaseConcurrency(orgId, snapshot.runId);
    }

    const run = await this.prisma.taskRun.findFirst({
      where: {
        id: snapshot.runId,
      },
      select: {
        runtimeEnvironment: {
          select: {
            id: true,
            projectId: true,
            organizationId: true,
          },
        },
      },
    });

    if (!run) {
      this.logger.error("Run not found for attemptToReleaseConcurrency", {
        runId: snapshot.runId,
      });

      return;
    }

    await this.releaseConcurrencyQueue.attemptToRelease(
      {
        orgId: run.runtimeEnvironment.organizationId,
        projectId: run.runtimeEnvironment.projectId,
        envId: run.runtimeEnvironment.id,
      },
      snapshot.runId
    );

    return;
  }

  async #executeReleasedConcurrencyFromQueue(
    descriptor: { orgId: string; projectId: string; envId: string },
    runId: string
  ) {
    this.logger.debug("Executing released concurrency", {
      descriptor,
      runId,
    });

    // - Runlock the run
    // - Get latest snapshot
    // - If the run is non suspended or going to be, then bail
    // - If the run is suspended or going to be, then release the concurrency
    await this.runLock.lock([runId], 5_000, async () => {
      const snapshot = await getLatestExecutionSnapshot(this.prisma, runId);

      if (!canReleaseConcurrency(snapshot.executionStatus)) {
        this.logger.debug("Run is not in a state to release concurrency", {
          runId,
          snapshot,
        });

        return;
      }

      return await this.runQueue.releaseConcurrency(descriptor.orgId, snapshot.runId);
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
    const result = await $transaction(
      this.prisma,
      async (tx) => {
        // 1. Find the TaskRuns blocked by this waitpoint
        const affectedTaskRuns = await tx.taskRunWaitpoint.findMany({
          where: { waitpointId: id },
          select: { taskRunId: true, spanIdToComplete: true, createdAt: true },
        });

        if (affectedTaskRuns.length === 0) {
          this.logger.warn(`completeWaitpoint: No TaskRunWaitpoints found for waitpoint`, {
            waitpointId: id,
          });
        }

        // 2. Update the waitpoint to completed (only if it's pending)
        let waitpoint: Waitpoint | null = null;
        try {
          waitpoint = await tx.waitpoint.update({
            where: { id, status: "PENDING" },
            data: {
              status: "COMPLETED",
              completedAt: new Date(),
              output: output?.value,
              outputType: output?.type,
              outputIsError: output?.isError,
            },
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
            waitpoint = await tx.waitpoint.findFirst({
              where: { id },
            });
          } else {
            this.logger.log("completeWaitpoint: error updating waitpoint:", { error });
            throw error;
          }
        }

        return { waitpoint, affectedTaskRuns };
      },
      (error) => {
        this.logger.error(`completeWaitpoint: Error completing waitpoint ${id}, retrying`, {
          error,
        });
        throw error;
      }
    );

    if (!result) {
      throw new Error(`Waitpoint couldn't be updated`);
    }

    if (!result.waitpoint) {
      throw new Error(`Waitpoint ${id} not found`);
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
          span: {
            id: run.spanIdToComplete,
            createdAt: run.createdAt,
          },
          blockedRunId: run.taskRunId,
          hasError: output?.isError ?? false,
        });
      }
    }

    return result.waitpoint;
  }

  /**
   * This gets called AFTER the checkpoint has been created
   * The CPU/Memory checkpoint at this point exists in our snapshot storage
   */
  async createCheckpoint({
    runId,
    snapshotId,
    checkpoint,
    workerId,
    runnerId,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    checkpoint: CheckpointInput;
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<CreateCheckpointResult> {
    const prisma = tx ?? this.prisma;

    return await this.runLock.lock([runId], 5_000, async () => {
      const snapshot = await getLatestExecutionSnapshot(prisma, runId);
      if (snapshot.id !== snapshotId) {
        this.eventBus.emit("incomingCheckpointDiscarded", {
          time: new Date(),
          run: {
            id: runId,
          },
          checkpoint: {
            discardReason: "Not the latest snapshot",
            metadata: checkpoint,
          },
          snapshot: {
            id: snapshot.id,
            executionStatus: snapshot.executionStatus,
          },
        });

        return {
          ok: false as const,
          error: "Not the latest snapshot",
        };
      }

      if (!isCheckpointable(snapshot.executionStatus)) {
        this.logger.error("Tried to createCheckpoint on a run in an invalid state", {
          snapshot,
        });

        this.eventBus.emit("incomingCheckpointDiscarded", {
          time: new Date(),
          run: {
            id: runId,
          },
          checkpoint: {
            discardReason: `Status ${snapshot.executionStatus} is not checkpointable`,
            metadata: checkpoint,
          },
          snapshot: {
            id: snapshot.id,
            executionStatus: snapshot.executionStatus,
          },
        });

        return {
          ok: false as const,
          error: `Status ${snapshot.executionStatus} is not checkpointable`,
        };
      }

      // Get the run and update the status
      const run = await this.prisma.taskRun.update({
        where: {
          id: runId,
        },
        data: {
          status: "WAITING_TO_RESUME",
        },
        select: {
          id: true,
          status: true,
          attemptNumber: true,
          runtimeEnvironment: {
            select: {
              id: true,
              projectId: true,
              organizationId: true,
            },
          },
        },
      });

      if (!run) {
        this.logger.error("Run not found for createCheckpoint", {
          snapshot,
        });

        throw new ServiceValidationError("Run not found", 404);
      }

      // Create the checkpoint
      const taskRunCheckpoint = await prisma.taskRunCheckpoint.create({
        data: {
          ...CheckpointId.generate(),
          type: checkpoint.type,
          location: checkpoint.location,
          imageRef: checkpoint.imageRef,
          reason: checkpoint.reason,
          runtimeEnvironmentId: run.runtimeEnvironment.id,
          projectId: run.runtimeEnvironment.projectId,
        },
      });

      //create a new execution snapshot, with the checkpoint
      const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
        run,
        snapshot: {
          executionStatus: "SUSPENDED",
          description: "Run was suspended after creating a checkpoint.",
        },
        environmentId: snapshot.environmentId,
        environmentType: snapshot.environmentType,
        checkpointId: taskRunCheckpoint.id,
        workerId,
        runnerId,
      });

      // Refill the token bucket for the release concurrency queue
      await this.releaseConcurrencyQueue.refillTokens(
        {
          orgId: run.runtimeEnvironment.organizationId,
          projectId: run.runtimeEnvironment.projectId,
          envId: run.runtimeEnvironment.id,
        },
        1
      );

      return {
        ok: true as const,
        ...executionResultFromSnapshot(newSnapshot),
        checkpoint: taskRunCheckpoint,
      } satisfies CreateCheckpointResult;
    });
  }

  /**
   * This is called when a run has been restored from a checkpoint and is ready to start executing again
   */
  async continueRunExecution({
    runId,
    snapshotId,
    workerId,
    runnerId,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<ExecutionResult> {
    const prisma = tx ?? this.prisma;

    return await this.runLock.lock([runId], 5_000, async () => {
      const snapshot = await getLatestExecutionSnapshot(prisma, runId);

      if (snapshot.id !== snapshotId) {
        throw new ServiceValidationError("Snapshot ID doesn't match the latest snapshot", 400);
      }

      if (!isPendingExecuting(snapshot.executionStatus)) {
        throw new ServiceValidationError("Snapshot is not in a valid state to continue", 400);
      }

      // Get the run and update the status
      const run = await this.prisma.taskRun.update({
        where: {
          id: runId,
        },
        data: {
          status: "EXECUTING",
        },
        select: {
          id: true,
          status: true,
          attemptNumber: true,
        },
      });

      if (!run) {
        this.logger.error("Run not found for createCheckpoint", {
          snapshot,
        });

        throw new ServiceValidationError("Run not found", 404);
      }

      const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
        run,
        snapshot: {
          executionStatus: "EXECUTING",
          description: "Run was continued after being suspended",
        },
        environmentId: snapshot.environmentId,
        environmentType: snapshot.environmentType,
        completedWaitpoints: snapshot.completedWaitpoints,
        workerId,
        runnerId,
      });

      // Let worker know about the new snapshot so it can continue the run
      await sendNotificationToWorker({ runId, snapshot: newSnapshot, eventBus: this.eventBus });

      return {
        ...executionResultFromSnapshot(newSnapshot),
      } satisfies ExecutionResult;
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
    workerId,
    runnerId,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<ExecutionResult> {
    return this.executionSnapshotSystem.heartbeatRun({
      runId,
      snapshotId,
      workerId,
      runnerId,
      tx,
    });
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
    try {
      //stop the run queue
      await this.releaseConcurrencyQueue.quit();
      await this.runQueue.quit();
      await this.worker.stop();
      await this.runLock.quit();

      // This is just a failsafe
      await this.runLockRedis.quit();
    } catch (error) {
      // And should always throw
    }
  }

  async #expireRun({ runId, tx }: { runId: string; tx?: PrismaClientOrTransaction }) {
    const prisma = tx ?? this.prisma;
    await this.runLock.lock([runId], 5_000, async () => {
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
              environmentId: snapshot.environmentId,
              environmentType: snapshot.environmentType,
            },
          },
        },
        select: {
          id: true,
          spanId: true,
          ttl: true,
          associatedWaitpoint: {
            select: {
              id: true,
            },
          },
          runtimeEnvironment: {
            select: {
              organizationId: true,
            },
          },
          createdAt: true,
          completedAt: true,
          taskEventStore: true,
          parentTaskRunId: true,
        },
      });

      await this.runQueue.acknowledgeMessage(updatedRun.runtimeEnvironment.organizationId, runId);

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

  //MARK: RunQueue
  /** The run can be added to the queue. When it's pulled from the queue it will be executed. */
  async #enqueueRun({
    run,
    env,
    timestamp,
    tx,
    snapshot,
    batchId,
    checkpointId,
    completedWaitpoints,
    workerId,
    runnerId,
  }: {
    run: TaskRun;
    env: MinimalAuthenticatedEnvironment;
    timestamp: number;
    tx?: PrismaClientOrTransaction;
    snapshot?: {
      status?: Extract<TaskRunExecutionStatus, "QUEUED" | "QUEUED_EXECUTING">;
      description?: string;
    };
    batchId?: string;
    checkpointId?: string;
    completedWaitpoints?: {
      id: string;
      index?: number;
    }[];
    workerId?: string;
    runnerId?: string;
  }): Promise<void> {
    const prisma = tx ?? this.prisma;

    await this.runLock.lock([run.id], 5000, async () => {
      const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(prisma, {
        run: run,
        snapshot: {
          executionStatus: snapshot?.status ?? "QUEUED",
          description: snapshot?.description ?? "Run was QUEUED",
        },
        batchId,
        environmentId: env.id,
        environmentType: env.type,
        checkpointId,
        completedWaitpoints,
        workerId,
        runnerId,
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
    await this.runLock.lock([runId], 5000, async () => {
      const snapshot = await getLatestExecutionSnapshot(this.prisma, runId);

      //run is still executing, send a message to the worker
      if (isExecuting(snapshot.executionStatus)) {
        const result = await this.runQueue.reacquireConcurrency(
          run.runtimeEnvironment.organization.id,
          runId
        );

        if (result) {
          const newSnapshot = await this.executionSnapshotSystem.createExecutionSnapshot(
            this.prisma,
            {
              run: {
                id: runId,
                status: snapshot.runStatus,
                attemptNumber: snapshot.attemptNumber,
              },
              snapshot: {
                executionStatus: "EXECUTING",
                description: "Run was continued, whilst still executing.",
              },
              environmentId: snapshot.environmentId,
              environmentType: snapshot.environmentType,
              batchId: snapshot.batchId ?? undefined,
              completedWaitpoints: blockingWaitpoints.map((b) => ({
                id: b.waitpoint.id,
                index: b.batchIndex ?? undefined,
              })),
            }
          );

          await sendNotificationToWorker({ runId, snapshot: newSnapshot, eventBus: this.eventBus });
        } else {
          // Because we cannot reacquire the concurrency, we need to enqueue the run again
          // and because the run is still executing, we need to set the status to QUEUED_EXECUTING
          await this.#enqueueRun({
            run,
            env: run.runtimeEnvironment,
            timestamp: run.createdAt.getTime() - run.priorityMs,
            snapshot: {
              status: "QUEUED_EXECUTING",
              description: "Run can continue, but is waiting for concurrency",
            },
            batchId: snapshot.batchId ?? undefined,
            completedWaitpoints: blockingWaitpoints.map((b) => ({
              id: b.waitpoint.id,
              index: b.batchIndex ?? undefined,
            })),
          });
        }
      } else {
        if (snapshot.executionStatus !== "RUN_CREATED" && !snapshot.checkpointId) {
          // TODO: We're screwed, should probably fail the run immediately
          throw new Error(`#continueRunIfUnblocked: run has no checkpoint: ${run.id}`);
        }

        //put it back in the queue, with the original timestamp (w/ priority)
        //this prioritizes dequeuing waiting runs over new runs
        await this.#enqueueRun({
          run,
          env: run.runtimeEnvironment,
          timestamp: run.createdAt.getTime() - run.priorityMs,
          snapshot: {
            description: "Run was QUEUED, because all waitpoints are completed",
          },
          batchId: snapshot.batchId ?? undefined,
          completedWaitpoints: blockingWaitpoints.map((b) => ({
            id: b.waitpoint.id,
            index: b.batchIndex ?? undefined,
          })),
          checkpointId: snapshot.checkpointId ?? undefined,
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

  async #enqueueDelayedRun({ runId }: { runId: string }) {
    const run = await this.prisma.taskRun.findFirst({
      where: { id: runId },
      include: {
        runtimeEnvironment: {
          include: {
            project: true,
            organization: true,
          },
        },
      },
    });

    if (!run) {
      throw new Error(`#enqueueDelayedRun: run not found: ${runId}`);
    }

    // Now we need to enqueue the run into the RunQueue
    await this.#enqueueRun({
      run,
      env: run.runtimeEnvironment,
      timestamp: run.createdAt.getTime() - run.priorityMs,
      batchId: run.batchId ?? undefined,
    });

    await this.prisma.taskRun.update({
      where: { id: runId },
      data: {
        status: "PENDING",
        queuedAt: new Date(),
      },
    });

    if (run.ttl) {
      const expireAt = parseNaturalLanguageDuration(run.ttl);

      if (expireAt) {
        await this.worker.enqueue({
          id: `expireRun:${runId}`,
          job: "expireRun",
          payload: { runId },
          availableAt: expireAt,
        });
      }
    }
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

  //#endregion

  //#region Heartbeat
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
    return await this.runLock.lock([runId], 5_000, async () => {
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

        await this.worker.ack(`heartbeatSnapshot.${runId}`);
        return;
      }

      this.logger.log("RunEngine.#handleStalledSnapshot() handling stalled snapshot", {
        runId,
        snapshot: latestSnapshot,
      });

      // For dev, we just cancel runs that are stuck
      if (latestSnapshot.environmentType === "DEVELOPMENT") {
        this.logger.log("RunEngine.#handleStalledSnapshot() cancelling DEV run", {
          runId,
          snapshot: latestSnapshot,
        });

        await this.cancelRun({
          runId: latestSnapshot.runId,
          finalizeRun: true,
          reason:
            "Run was disconnected, check you're running the CLI dev command and your network connection is healthy.",
          tx,
        });
        return;
      }

      switch (latestSnapshot.executionStatus) {
        case "RUN_CREATED": {
          throw new NotImplementedError("There shouldn't be a heartbeat for RUN_CREATED");
        }
        case "QUEUED": {
          throw new NotImplementedError("There shouldn't be a heartbeat for QUEUED");
        }
        case "QUEUED_EXECUTING": {
          throw new NotImplementedError("There shouldn't be a heartbeat for QUEUED_EXECUTING");
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
          break;
        }
        case "EXECUTING":
        case "EXECUTING_WITH_WAITPOINTS": {
          const retryDelay = 250;

          //todo call attemptFailed and force requeuing
          await this.runAttemptSystem.attemptFailed({
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
                message: `Run stalled while executing. This can happen when the run becomes unresponsive, for example because the CPU is overloaded.`,
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
