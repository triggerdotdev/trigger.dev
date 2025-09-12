import { createRedisClient, Redis } from "@internal/redis";
import { getMeter, Meter, startSpan, trace, Tracer } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import {
  CheckpointInput,
  CompleteRunAttemptResult,
  CreateCheckpointResult,
  DequeuedMessage,
  ExecutionResult,
  formatDurationMilliseconds,
  RunExecutionData,
  StartRunAttemptResult,
  TaskRunContext,
  TaskRunExecutionResult,
  TaskRunInternalError,
} from "@trigger.dev/core/v3";
import { RunId, WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import {
  Prisma,
  PrismaClient,
  PrismaClientOrTransaction,
  PrismaReplicaClient,
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
import { BillingCache } from "./billingCache.js";
import { NotImplementedError, RunDuplicateIdempotencyKeyError } from "./errors.js";
import { EventBus, EventBusEvents } from "./eventBus.js";
import { RunLocker } from "./locking.js";
import { getFinalRunStatuses } from "./statuses.js";
import { BatchSystem } from "./systems/batchSystem.js";
import { CheckpointSystem } from "./systems/checkpointSystem.js";
import { DelayedRunSystem } from "./systems/delayedRunSystem.js";
import { DequeueSystem } from "./systems/dequeueSystem.js";
import { EnqueueSystem } from "./systems/enqueueSystem.js";
import {
  executionDataFromSnapshot,
  ExecutionSnapshotSystem,
  getExecutionSnapshotsSince,
  getLatestExecutionSnapshot,
} from "./systems/executionSnapshotSystem.js";
import { PendingVersionSystem } from "./systems/pendingVersionSystem.js";
import { RaceSimulationSystem } from "./systems/raceSimulationSystem.js";
import { RunAttemptSystem } from "./systems/runAttemptSystem.js";
import { SystemResources } from "./systems/systems.js";
import { TtlSystem } from "./systems/ttlSystem.js";
import { WaitpointSystem } from "./systems/waitpointSystem.js";
import { EngineWorker, HeartbeatTimeouts, RunEngineOptions, TriggerParams } from "./types.js";
import { workerCatalog } from "./workerCatalog.js";

export class RunEngine {
  private runLockRedis: Redis;
  private runLock: RunLocker;
  private worker: EngineWorker;
  private logger: Logger;
  private tracer: Tracer;
  private meter: Meter;
  private heartbeatTimeouts: HeartbeatTimeouts;

  prisma: PrismaClient;
  readOnlyPrisma: PrismaReplicaClient;
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
  raceSimulationSystem: RaceSimulationSystem = new RaceSimulationSystem();

  private readonly billingCache: BillingCache;

  constructor(private readonly options: RunEngineOptions) {
    this.logger = options.logger ?? new Logger("RunEngine", this.options.logLevel ?? "info");
    this.prisma = options.prisma;
    this.readOnlyPrisma = options.readOnlyPrisma ?? this.prisma;
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
      meter: options.meter,
      duration: options.runLock.duration ?? 5000,
      automaticExtensionThreshold: options.runLock.automaticExtensionThreshold ?? 1000,
      retryConfig: {
        maxAttempts: 10,
        baseDelay: 100,
        maxDelay: 3000,
        backoffMultiplier: 1.8,
        jitterFactor: 0.15,
        maxTotalWaitTime: 15000,
        ...options.runLock.retryConfig,
      },
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
      defaultEnvConcurrencyBurstFactor: options.queue?.defaultEnvConcurrencyBurstFactor,
      logger: new Logger("RunQueue", options.queue?.logLevel ?? "info"),
      redis: { ...options.queue.redis, keyPrefix: `${options.queue.redis.keyPrefix}runqueue:` },
      retryOptions: options.queue?.retryOptions,
      workerOptions: {
        disabled: options.worker.disabled,
        concurrency: options.worker,
        pollIntervalMs: options.worker.pollIntervalMs,
        immediatePollIntervalMs: options.worker.immediatePollIntervalMs,
        shutdownTimeoutMs: options.worker.shutdownTimeoutMs,
      },
      concurrencySweeper: {
        scanSchedule: options.queue?.concurrencySweeper?.scanSchedule,
        processMarkedSchedule: options.queue?.concurrencySweeper?.processMarkedSchedule,
        scanJitterInMs: options.queue?.concurrencySweeper?.scanJitterInMs,
        processMarkedJitterInMs: options.queue?.concurrencySweeper?.processMarkedJitterInMs,
        callback: this.#concurrencySweeperCallback.bind(this),
      },
      shardCount: options.queue?.shardCount,
      masterQueueConsumersDisabled: options.queue?.masterQueueConsumersDisabled,
      masterQueueConsumersIntervalMs: options.queue?.masterQueueConsumersIntervalMs,
      processWorkerQueueDebounceMs: options.queue?.processWorkerQueueDebounceMs,
      dequeueBlockingTimeoutSeconds: options.queue?.dequeueBlockingTimeoutSeconds,
      meter: options.meter,
    });

    this.worker = new Worker({
      name: "run-engine-worker",
      redisOptions: {
        ...options.worker.redis,
        keyPrefix: `${options.worker.redis.keyPrefix}worker:`,
      },
      catalog: workerCatalog,
      concurrency: options.worker,
      pollIntervalMs: options.worker.pollIntervalMs,
      immediatePollIntervalMs: options.worker.immediatePollIntervalMs,
      shutdownTimeoutMs: options.worker.shutdownTimeoutMs,
      logger: new Logger("RunEngineWorker", options.logLevel ?? "info"),
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
      console.log("✅ Starting run engine worker");

      this.worker.start();
    }

    this.tracer = options.tracer;
    this.meter = options.meter ?? getMeter("run-engine");

    const defaultHeartbeatTimeouts: HeartbeatTimeouts = {
      PENDING_EXECUTING: 60_000,
      PENDING_CANCEL: 60_000,
      EXECUTING: 60_000,
      EXECUTING_WITH_WAITPOINTS: 60_000,
      SUSPENDED: 60_000 * 10,
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
      meter: this.meter,
      runLock: this.runLock,
      runQueue: this.runQueue,
      raceSimulationSystem: this.raceSimulationSystem,
    };

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
      redisOptions: this.options.cache?.redis ?? this.options.runLock.redis,
    });

    this.billingCache = new BillingCache({
      billingOptions: this.options.billing,
      redisOptions: this.options.cache?.redis ?? this.options.runLock.redis,
      logger: this.logger,
    });

    this.dequeueSystem = new DequeueSystem({
      resources,
      executionSnapshotSystem: this.executionSnapshotSystem,
      runAttemptSystem: this.runAttemptSystem,
      machines: this.options.machines,
      billingCache: this.billingCache,
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
      workerQueue,
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
      replayedFromTaskRunFriendlyId,
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
      scheduleId,
      scheduleInstanceId,
      createdAt,
      bulkActionId,
      planType,
    }: TriggerParams,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    const prisma = tx ?? this.prisma;

    return startSpan(
      this.tracer,
      "trigger",
      async (span) => {
        const status = delayUntil ? "DELAYED" : "PENDING";

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
              workerQueue,
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
              replayedFromTaskRunFriendlyId,
              batchId: batch?.id,
              resumeParentOnCompletion,
              depth,
              metadata,
              metadataType,
              seedMetadata,
              seedMetadataType,
              maxDurationInSeconds,
              machinePreset: machine,
              scheduleId,
              scheduleInstanceId,
              createdAt,
              bulkActionGroupIds: bulkActionId ? [bulkActionId] : undefined,
              planType,
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
          });
        }

        if (taskRun.delayUntil) {
          // Schedule the run to be enqueued at the delayUntil time
          await this.delayedRunSystem.scheduleDelayedRunEnqueuing({
            runId: taskRun.id,
            delayUntil: taskRun.delayUntil,
          });
        } else {
          if (taskRun.ttl) {
            await this.ttlSystem.scheduleExpireRun({ runId: taskRun.id, ttl: taskRun.ttl });
          }

          await this.enqueueSystem.enqueueRun({
            run: taskRun,
            env: environment,
            workerId,
            runnerId,
            tx: prisma,
            skipRunLock: true,
          });
        }

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
   * @param workerQueue: The worker queue to pull from, can be an individual environment (for dev)
   * @returns
   */
  async dequeueFromWorkerQueue({
    consumerId,
    workerQueue,
    backgroundWorkerId,
    workerId,
    runnerId,
    tx,
    skipObserving,
    blockingPop,
    blockingPopTimeoutSeconds,
  }: {
    consumerId: string;
    workerQueue: string;
    backgroundWorkerId?: string;
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
    skipObserving?: boolean;
    blockingPop?: boolean;
    blockingPopTimeoutSeconds?: number;
  }): Promise<DequeuedMessage[]> {
    if (!skipObserving) {
      // We only do this with "prod" worker queues because we don't want to observe dev (e.g. environment) worker queues
      this.runQueue.registerObservableWorkerQueue(workerQueue);
    }

    const dequeuedMessage = await this.dequeueSystem.dequeueFromWorkerQueue({
      consumerId,
      workerQueue,
      backgroundWorkerId,
      workerId,
      runnerId,
      tx,
      blockingPop,
      blockingPopTimeoutSeconds,
    });

    if (!dequeuedMessage) {
      return [];
    }

    return [dequeuedMessage];
  }

  async dequeueFromEnvironmentWorkerQueue({
    consumerId,
    environmentId,
    backgroundWorkerId,
    workerId,
    runnerId,
    tx,
  }: {
    consumerId: string;
    environmentId: string;
    backgroundWorkerId?: string;
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<DequeuedMessage[]> {
    return this.dequeueFromWorkerQueue({
      consumerId,
      workerQueue: environmentId,
      backgroundWorkerId,
      workerId,
      runnerId,
      tx,
      skipObserving: true,
      blockingPop: true,
      blockingPopTimeoutSeconds: 10,
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
    bulkActionId,
    tx,
  }: {
    runId: string;
    workerId?: string;
    runnerId?: string;
    completedAt?: Date;
    reason?: string;
    finalizeRun?: boolean;
    bulkActionId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<ExecutionResult & { alreadyFinished: boolean }> {
    return this.runAttemptSystem.cancelRun({
      runId,
      workerId,
      runnerId,
      completedAt,
      reason,
      finalizeRun,
      bulkActionId,
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
    runtimeEnvironmentId,
    organizationId,
    projectId,
  }: {
    runtimeEnvironmentId: string;
    organizationId: string;
    projectId: string;
  }) {
    return this.runQueue.removeEnvironmentQueuesFromMasterQueue(
      runtimeEnvironmentId,
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

  async resolveTaskRunContext(runId: string): Promise<TaskRunContext> {
    return this.runAttemptSystem.resolveTaskRunContext(runId);
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

  async migrateLegacyMasterQueues() {
    const workerGroups = await this.prisma.workerInstanceGroup.findMany({
      where: {
        type: "MANAGED",
      },
      select: {
        id: true,
        name: true,
        masterQueue: true,
      },
    });

    this.logger.info("Migrating legacy master queues", {
      workerGroups,
    });

    for (const workerGroup of workerGroups) {
      this.logger.info("Migrating legacy master queue", {
        workerGroupId: workerGroup.id,
        workerGroupName: workerGroup.name,
        workerGroupMasterQueue: workerGroup.masterQueue,
      });

      await this.runQueue.migrateLegacyMasterQueue(workerGroup.masterQueue);

      this.logger.info("Migrated legacy master queue", {
        workerGroupId: workerGroup.id,
        workerGroupName: workerGroup.name,
        workerGroupMasterQueue: workerGroup.masterQueue,
      });
    }
  }

  async quit() {
    try {
      //stop the run queue
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
    restartAttempt,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    restartAttempt?: number;
    tx?: PrismaClientOrTransaction;
  }) {
    const prisma = tx ?? this.prisma;
    return await this.runLock.lock("handleStalledSnapshot", [runId], async () => {
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
            checkpointId: latestSnapshot.checkpointId ?? undefined,
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
          // Stalls for production runs should start being treated as an OOM error.
          // We should calculate the retry delay using the retry settings on the run/task instead of hardcoding it.
          // Stalls for dev runs should keep being treated as a timeout error because the vast majority of the time these snapshots stall because
          // they have quit the CLI

          const retryDelay = 250;

          const timeoutDuration =
            latestSnapshot.executionStatus === "EXECUTING"
              ? formatDurationMilliseconds(this.heartbeatTimeouts.EXECUTING)
              : formatDurationMilliseconds(this.heartbeatTimeouts.EXECUTING_WITH_WAITPOINTS);

          // Dev runs don't retry, because the vast majority of the time these snapshots stall because
          // they have quit the CLI
          const shouldRetry = latestSnapshot.environmentType !== "DEVELOPMENT";
          const errorMessage =
            latestSnapshot.environmentType === "DEVELOPMENT"
              ? `Run timed out after ${timeoutDuration} due to missing heartbeats (sent every 30s). Check if your \`trigger.dev dev\` CLI is still running, or if CPU-heavy work is blocking the main thread.`
              : `Run timed out after ${timeoutDuration} due to missing heartbeats (sent every 30s). This typically happens when CPU-heavy work blocks the main thread.`;

          const taskStalledErrorCode =
            latestSnapshot.executionStatus === "EXECUTING"
              ? "TASK_RUN_STALLED_EXECUTING"
              : "TASK_RUN_STALLED_EXECUTING_WITH_WAITPOINTS";

          const error =
            latestSnapshot.environmentType === "DEVELOPMENT"
              ? ({
                  type: "INTERNAL_ERROR",
                  code: taskStalledErrorCode,
                  message: errorMessage,
                } satisfies TaskRunInternalError)
              : this.options.treatProductionExecutionStallsAsOOM
              ? ({
                  type: "INTERNAL_ERROR",
                  code: "TASK_PROCESS_OOM_KILLED",
                  message: "Run was terminated due to running out of memory",
                } satisfies TaskRunInternalError)
              : ({
                  type: "INTERNAL_ERROR",
                  code: taskStalledErrorCode,
                  message: errorMessage,
                } satisfies TaskRunInternalError);

          await this.runAttemptSystem.attemptFailed({
            runId,
            snapshotId: latestSnapshot.id,
            completion: {
              ok: false,
              id: runId,
              error,
              retry: shouldRetry
                ? {
                    //250ms in the future
                    timestamp: Date.now() + retryDelay,
                    delay: retryDelay,
                  }
                : undefined,
            },
            forceRequeue: true,
            tx: prisma,
          });
          break;
        }
        case "SUSPENDED": {
          const result = await this.waitpointSystem.continueRunIfUnblocked({ runId });

          this.logger.info("handleStalledSnapshot SUSPENDED continueRunIfUnblocked", {
            runId,
            result,
            snapshotId: latestSnapshot.id,
          });

          switch (result.status) {
            case "blocked": {
              if (!this.options.suspendedHeartbeatRetriesConfig) {
                break;
              }

              if (result.waitpoints.length === 0) {
                this.logger.info("handleStalledSnapshot SUSPENDED blocked but no waitpoints", {
                  runId,
                  result,
                  snapshotId: latestSnapshot.id,
                });
                // If the run is blocked but there are no waitpoints, we don't restart the heartbeat
                break;
              }

              const hasRunOrBatchWaitpoints = result.waitpoints.some(
                (w) => w.type === "RUN" || w.type === "BATCH"
              );

              if (!hasRunOrBatchWaitpoints) {
                this.logger.info(
                  "handleStalledSnapshot SUSPENDED blocked but no run or batch waitpoints",
                  {
                    runId,
                    result,
                    snapshotId: latestSnapshot.id,
                  }
                );
                // If the run is blocked by waitpoints that are not RUN or BATCH, we don't restart the heartbeat
                break;
              }

              const initialDelayMs =
                this.options.suspendedHeartbeatRetriesConfig.initialDelayMs ?? 60_000;
              const $restartAttempt = (restartAttempt ?? 0) + 1; // Start at 1
              const maxDelayMs =
                this.options.suspendedHeartbeatRetriesConfig.maxDelayMs ?? 60_000 * 60 * 6; // 6 hours
              const factor = this.options.suspendedHeartbeatRetriesConfig.factor ?? 2;
              const maxCount = this.options.suspendedHeartbeatRetriesConfig.maxCount ?? 12;

              if ($restartAttempt >= maxCount) {
                this.logger.info(
                  "handleStalledSnapshot SUSPENDED blocked with waitpoints, max retries reached",
                  {
                    runId,
                    result,
                    snapshotId: latestSnapshot.id,
                    restartAttempt: $restartAttempt,
                    maxCount,
                    config: this.options.suspendedHeartbeatRetriesConfig,
                  }
                );

                break;
              }

              // Calculate the delay based on the retry attempt
              const delayMs = Math.min(
                initialDelayMs * Math.pow(factor, $restartAttempt - 1),
                maxDelayMs
              );

              this.logger.info(
                "handleStalledSnapshot SUSPENDED blocked with waitpoints, restarting heartbeat",
                {
                  runId,
                  result,
                  snapshotId: latestSnapshot.id,
                  delayMs,
                  restartAttempt: $restartAttempt,
                }
              );

              // Reschedule the heartbeat
              await this.executionSnapshotSystem.restartHeartbeatForRun({
                runId,
                delayMs,
                restartAttempt: $restartAttempt,
                tx,
              });
              break;
            }
            case "unblocked":
            case "skipped": {
              break;
            }
          }

          break;
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

  async #concurrencySweeperCallback(
    runIds: string[]
  ): Promise<Array<{ id: string; orgId: string }>> {
    const runs = await this.readOnlyPrisma.taskRun.findMany({
      where: {
        id: { in: runIds },
        completedAt: {
          lte: new Date(Date.now() - 1000 * 60 * 10), // This only finds runs that were completed more than 10 minutes ago
        },
        organizationId: {
          not: null,
        },
        status: {
          in: getFinalRunStatuses(),
        },
      },
      select: {
        id: true,
        status: true,
        organizationId: true,
      },
    });

    // Log the finished runs
    for (const run of runs) {
      this.logger.info("Concurrency sweeper callback found finished run", {
        runId: run.id,
        orgId: run.organizationId,
        status: run.status,
      });
    }

    return runs
      .filter((run) => !!run.organizationId)
      .map((run) => ({
        id: run.id,
        orgId: run.organizationId!,
      }));
  }

  /**
   * Invalidates the billing cache for an organization when their plan changes
   * Runs in background and handles all errors internally
   */
  invalidateBillingCache(orgId: string): void {
    this.billingCache.invalidate(orgId);
  }
}
