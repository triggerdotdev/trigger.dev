import { createRedisClient, Redis } from "@internal/redis";
import { startSpan, trace, Tracer } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import {
  CheckpointInput,
  CompleteRunAttemptResult,
  CreateCheckpointResult,
  DequeuedMessage,
  ExecutionResult,
  MachineResources,
  RunExecutionData,
  StartRunAttemptResult,
  TaskRunExecutionResult,
} from "@trigger.dev/core/v3";
import { BatchId, RunId, WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import {
  Prisma,
  PrismaClient,
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunExecutionSnapshot,
  Waitpoint,
} from "@trigger.dev/database";
import { Worker } from "@trigger.dev/redis-worker";
import { assertNever } from "assert-never";
import { EventEmitter } from "node:events";
import { FairQueueSelectionStrategy } from "../run-queue/fairQueueSelectionStrategy.js";
import { RunQueue } from "../run-queue/index.js";
import { RunQueueFullKeyProducer } from "../run-queue/keyProducer.js";
import { MinimalAuthenticatedEnvironment } from "../shared/index.js";
import { NotImplementedError, RunDuplicateIdempotencyKeyError } from "./errors.js";
import { EventBus, EventBusEvents } from "./eventBus.js";
import { RunLocker } from "./locking.js";
import { BatchSystem } from "./systems/batchSystem.js";
import { CheckpointSystem } from "./systems/checkpointSystem.js";
import { DelayedRunSystem } from "./systems/delayedRunSystem.js";
import { DequeueSystem } from "./systems/dequeueSystem.js";
import { EnqueueSystem } from "./systems/enqueueSystem.js";
import {
  ExecutionSnapshotSystem,
  getLatestExecutionSnapshot,
  getExecutionSnapshotsSince,
  executionDataFromSnapshot,
} from "./systems/executionSnapshotSystem.js";
import { PendingVersionSystem } from "./systems/pendingVersionSystem.js";
import { ReleaseConcurrencySystem } from "./systems/releaseConcurrencySystem.js";
import { RunAttemptSystem } from "./systems/runAttemptSystem.js";
import { SystemResources } from "./systems/systems.js";
import { TtlSystem } from "./systems/ttlSystem.js";
import { WaitpointSystem } from "./systems/waitpointSystem.js";
import { EngineWorker, HeartbeatTimeouts, RunEngineOptions, TriggerParams } from "./types.js";
import { workerCatalog } from "./workerCatalog.js";
import { RaceSimulationSystem } from "./systems/raceSimulationSystem.js";

export class RunEngine {
  private runLockRedis: Redis;
  private runLock: RunLocker;
  private worker: EngineWorker;
  private logger = new Logger("RunEngine", "debug");
  private tracer: Tracer;
  private heartbeatTimeouts: HeartbeatTimeouts;

  prisma: PrismaClient;
  runQueue: RunQueue;
  eventBus: EventBus = new EventEmitter<EventBusEvents>();
  executionSnapshotSystem: ExecutionSnapshotSystem;
  runAttemptSystem: RunAttemptSystem;
  dequeueSystem: DequeueSystem;
  waitpointSystem: WaitpointSystem;
  batchSystem: BatchSystem;
  enqueueSystem: EnqueueSystem;
  checkpointSystem: CheckpointSystem;
  delayedRunSystem: DelayedRunSystem;
  ttlSystem: TtlSystem;
  pendingVersionSystem: PendingVersionSystem;
  releaseConcurrencySystem: ReleaseConcurrencySystem;
  raceSimulationSystem: RaceSimulationSystem = new RaceSimulationSystem();

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
    this.runLock = new RunLocker({
      redis: this.runLockRedis,
      logger: this.logger,
      tracer: trace.getTracer("RunLocker"),
    });

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
      shutdownTimeoutMs: options.worker.shutdownTimeoutMs,
      logger: new Logger("RunEngineWorker", "debug"),
      jobs: {
        finishWaitpoint: async ({ payload }) => {
          await this.waitpointSystem.completeWaitpoint({
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
          await this.ttlSystem.expireRun({ runId: payload.runId });
        },
        cancelRun: async ({ payload }) => {
          await this.runAttemptSystem.cancelRun({
            runId: payload.runId,
            completedAt: payload.completedAt,
            reason: payload.reason,
          });
        },
        queueRunsPendingVersion: async ({ payload }) => {
          await this.pendingVersionSystem.enqueueRunsForBackgroundWorker(
            payload.backgroundWorkerId
          );
        },
        tryCompleteBatch: async ({ payload }) => {
          await this.batchSystem.performCompleteBatch({ batchId: payload.batchId });
        },
        continueRunIfUnblocked: async ({ payload }) => {
          await this.waitpointSystem.continueRunIfUnblocked({
            runId: payload.runId,
          });
        },
        enqueueDelayedRun: async ({ payload }) => {
          await this.delayedRunSystem.enqueueDelayedRun({ runId: payload.runId });
        },
      },
    });

    if (!options.worker.disabled) {
      this.worker.start();
    }

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

    const resources: SystemResources = {
      prisma: this.prisma,
      worker: this.worker,
      eventBus: this.eventBus,
      logger: this.logger,
      tracer: this.tracer,
      runLock: this.runLock,
      runQueue: this.runQueue,
      raceSimulationSystem: this.raceSimulationSystem,
    };

    this.releaseConcurrencySystem = new ReleaseConcurrencySystem({
      resources,
      queueOptions:
        typeof options.releaseConcurrency?.disabled === "boolean" &&
        options.releaseConcurrency.disabled
          ? undefined
          : {
              disableConsumers: options.releaseConcurrency?.disableConsumers,
              redis: {
                ...options.queue.redis, // Use base queue redis options
                ...options.releaseConcurrency?.redis, // Allow overrides
                keyPrefix: `${options.queue.redis.keyPrefix ?? ""}release-concurrency:`,
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
              executor: async (descriptor, snapshotId) => {
                return await this.releaseConcurrencySystem.executeReleaseConcurrencyForSnapshot(
                  snapshotId
                );
              },
              maxTokens: async (descriptor) => {
                const environment = await this.prisma.runtimeEnvironment.findFirstOrThrow({
                  where: { id: descriptor.envId },
                  select: {
                    maximumConcurrencyLimit: true,
                  },
                });

                return (
                  environment.maximumConcurrencyLimit *
                  (options.releaseConcurrency?.maxTokensRatio ?? 1.0)
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
            },
    });

    this.executionSnapshotSystem = new ExecutionSnapshotSystem({
      resources,
      heartbeatTimeouts: this.heartbeatTimeouts,
    });

    this.enqueueSystem = new EnqueueSystem({
      resources,
      executionSnapshotSystem: this.executionSnapshotSystem,
    });

    this.checkpointSystem = new CheckpointSystem({
      resources,
      releaseConcurrencySystem: this.releaseConcurrencySystem,
      executionSnapshotSystem: this.executionSnapshotSystem,
      enqueueSystem: this.enqueueSystem,
    });

    this.delayedRunSystem = new DelayedRunSystem({
      resources,
      enqueueSystem: this.enqueueSystem,
    });

    this.pendingVersionSystem = new PendingVersionSystem({
      resources,
      enqueueSystem: this.enqueueSystem,
    });

    this.waitpointSystem = new WaitpointSystem({
      resources,
      executionSnapshotSystem: this.executionSnapshotSystem,
      enqueueSystem: this.enqueueSystem,
      releaseConcurrencySystem: this.releaseConcurrencySystem,
    });

    this.ttlSystem = new TtlSystem({
      resources,
      waitpointSystem: this.waitpointSystem,
    });

    this.batchSystem = new BatchSystem({
      resources,
      waitpointSystem: this.waitpointSystem,
    });

    this.runAttemptSystem = new RunAttemptSystem({
      resources,
      executionSnapshotSystem: this.executionSnapshotSystem,
      batchSystem: this.batchSystem,
      waitpointSystem: this.waitpointSystem,
      delayedRunSystem: this.delayedRunSystem,
      machines: this.options.machines,
      retryWarmStartThresholdMs: this.options.retryWarmStartThresholdMs,
    });

    this.dequeueSystem = new DequeueSystem({
      resources,
      executionSnapshotSystem: this.executionSnapshotSystem,
      runAttemptSystem: this.runAttemptSystem,
      machines: this.options.machines,
      releaseConcurrencySystem: this.releaseConcurrencySystem,
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
      queue,
      lockedQueueId,
      isTest,
      delayUntil,
      queuedAt,
      maxAttempts,
      taskEventStore,
      priorityMs,
      queueTimestamp,
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
      releaseConcurrency,
      runChainState,
      scheduleId,
      scheduleInstanceId,
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
          secondaryMasterQueue = this.#environmentMasterQueueKey(environment.id);
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
              environmentType: environment.type,
              organizationId: environment.organization.id,
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
              queue,
              lockedQueueId,
              masterQueue,
              secondaryMasterQueue,
              isTest,
              delayUntil,
              queuedAt,
              maxAttempts,
              taskEventStore,
              priorityMs,
              queueTimestamp: queueTimestamp ?? delayUntil ?? new Date(),
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
              runChainState,
              scheduleId,
              scheduleInstanceId,
              executionSnapshots: {
                create: {
                  engine: "V2",
                  executionStatus: "RUN_CREATED",
                  description: "Run was created",
                  runStatus: status,
                  environmentId: environment.id,
                  environmentType: environment.type,
                  projectId: environment.project.id,
                  organizationId: environment.organization.id,
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

        await this.runLock.lock("trigger", [taskRun.id], 5000, async (signal) => {
          //create associated waitpoint (this completes when the run completes)
          const associatedWaitpoint = await this.waitpointSystem.createRunAssociatedWaitpoint(
            prisma,
            {
              projectId: environment.project.id,
              environmentId: environment.id,
              completedByTaskRunId: taskRun.id,
            }
          );

          //triggerAndWait or batchTriggerAndWait
          if (resumeParentOnCompletion && parentTaskRunId) {
            //this will block the parent run from continuing until this waitpoint is completed (and removed)
            await this.waitpointSystem.blockRunWithWaitpoint({
              runId: parentTaskRunId,
              waitpoints: associatedWaitpoint.id,
              projectId: associatedWaitpoint.projectId,
              organizationId: environment.organization.id,
              batch,
              workerId,
              runnerId,
              tx: prisma,
              releaseConcurrency,
            });
          }

          //Make sure lock extension succeeded
          signal.throwIfAborted();

          if (taskRun.delayUntil) {
            // Schedule the run to be enqueued at the delayUntil time
            await this.delayedRunSystem.scheduleDelayedRunEnqueuing({
              runId: taskRun.id,
              delayUntil: taskRun.delayUntil,
            });
          } else {
            await this.enqueueSystem.enqueueRun({
              run: taskRun,
              env: environment,
              workerId,
              runnerId,
              tx: prisma,
            });

            if (taskRun.ttl) {
              await this.ttlSystem.scheduleExpireRun({ runId: taskRun.id, ttl: taskRun.ttl });
            }
          }
        });

        this.eventBus.emit("runCreated", {
          time: new Date(),
          runId: taskRun.id,
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

  async scheduleEnqueueRunsForBackgroundWorker(backgroundWorkerId: string): Promise<void> {
    return this.pendingVersionSystem.scheduleResolvePendingVersionRuns(backgroundWorkerId);
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
    return this.delayedRunSystem.rescheduleDelayedRun({
      runId,
      delayUntil,
      tx,
    });
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

  async removeEnvironmentQueuesFromMasterQueue({
    masterQueue,
    organizationId,
    projectId,
  }: {
    masterQueue: string;
    organizationId: string;
    projectId: string;
  }) {
    return this.runQueue.removeEnvironmentQueuesFromMasterQueue(
      masterQueue,
      organizationId,
      projectId
    );
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
    return this.waitpointSystem.createDateTimeWaitpoint({
      projectId,
      environmentId,
      completedAfter,
      idempotencyKey,
      idempotencyKeyExpiresAt,
      tx,
    });
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
    tags,
  }: {
    environmentId: string;
    projectId: string;
    idempotencyKey?: string;
    idempotencyKeyExpiresAt?: Date;
    timeout?: Date;
    tags?: string[];
  }): Promise<{ waitpoint: Waitpoint; isCached: boolean }> {
    return this.waitpointSystem.createManualWaitpoint({
      environmentId,
      projectId,
      idempotencyKey,
      idempotencyKeyExpiresAt,
      timeout,
      tags,
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
    return this.waitpointSystem.blockRunWithWaitpoint({
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
    return this.waitpointSystem.completeWaitpoint({ id, output });
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
    return this.checkpointSystem.createCheckpoint({
      runId,
      snapshotId,
      checkpoint,
      workerId,
      runnerId,
      tx,
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
    return this.checkpointSystem.continueRunExecution({
      runId,
      snapshotId,
      workerId,
      runnerId,
      tx,
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
      return executionDataFromSnapshot(snapshot);
    } catch (e) {
      this.logger.error("Failed to getRunExecutionData", {
        message: e instanceof Error ? e.message : e,
      });
      return null;
    }
  }

  async getSnapshotsSince({
    runId,
    snapshotId,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<RunExecutionData[] | null> {
    const prisma = tx ?? this.prisma;

    try {
      const snapshots = await getExecutionSnapshotsSince(prisma, runId, snapshotId);
      return snapshots.map(executionDataFromSnapshot);
    } catch (e) {
      this.logger.error("Failed to getSnapshotsSince", {
        message: e instanceof Error ? e.message : e,
      });
      return null;
    }
  }

  async registerRacepointForRun({ runId, waitInterval }: { runId: string; waitInterval: number }) {
    return this.raceSimulationSystem.registerRacepointForRun({ runId, waitInterval });
  }

  async quit() {
    try {
      //stop the run queue
      await this.releaseConcurrencySystem.quit();
      await this.runQueue.quit();
      await this.worker.stop();
      await this.runLock.quit();

      // This is just a failsafe
      await this.runLockRedis.quit();
    } catch (error) {
      // And should always throw
    }
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
    return await this.runLock.lock("handleStalledSnapshot", [runId], 5_000, async () => {
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
          await this.runAttemptSystem.tryNackAndRequeue({
            run,
            environment: {
              id: latestSnapshot.environmentId,
              type: latestSnapshot.environmentType,
            },
            orgId: latestSnapshot.organizationId,
            projectId: latestSnapshot.projectId,
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

  #environmentMasterQueueKey(environmentId: string) {
    return `master-env:${environmentId}`;
  }

  #backgroundWorkerQueueKey(backgroundWorkerId: string) {
    return `master-background-worker:${backgroundWorkerId}`;
  }
}
