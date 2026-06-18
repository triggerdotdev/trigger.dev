import { createRedisClient, Redis } from "@internal/redis";
import { type Counter, getMeter, Meter, startSpan, trace, Tracer } from "@internal/tracing";
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
import { TaskRunError } from "@trigger.dev/core/v3/schemas";
import {
  parseNaturalLanguageDurationInMs,
  RunId,
  WaitpointId,
} from "@trigger.dev/core/v3/isomorphic";
import {
  Prisma,
  PrismaClient,
  PrismaClientOrTransaction,
  PrismaReplicaClient,
  RuntimeEnvironmentType,
  TaskRun,
  TaskRunExecutionSnapshot,
  Waitpoint,
} from "@trigger.dev/database";
import { Worker } from "@trigger.dev/redis-worker";
import { assertNever } from "assert-never";
import { EventEmitter } from "node:events";
import { setTimeout } from "node:timers/promises";
import { BatchQueue } from "../batch-queue/index.js";
import type {
  BatchItem,
  CompleteBatchResult,
  InitializeBatchOptions,
  ProcessBatchItemCallback,
  BatchCompletionCallback,
} from "../batch-queue/types.js";
import { FairQueueSelectionStrategy } from "../run-queue/fairQueueSelectionStrategy.js";
import { RunQueue } from "../run-queue/index.js";
import { RunQueueFullKeyProducer } from "../run-queue/keyProducer.js";
import { AuthenticatedEnvironment, MinimalAuthenticatedEnvironment } from "../shared/index.js";
import { BillingCache } from "./billingCache.js";
import {
  ExecutionSnapshotNotFoundError,
  NotImplementedError,
  RunDuplicateIdempotencyKeyError,
  RunOneTimeUseTokenError,
} from "./errors.js";
import { EventBus, EventBusEvents } from "./eventBus.js";
import { RunLocker } from "./locking.js";
import { getFinalRunStatuses } from "./statuses.js";
import { BatchSystem } from "./systems/batchSystem.js";
import { CheckpointSystem } from "./systems/checkpointSystem.js";
import { DebounceSystem } from "./systems/debounceSystem.js";
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
import { NoopPendingVersionRunIdLookup } from "./services/pendingVersionLookup.js";
import { SystemResources } from "./systems/systems.js";
import { PostgresRunStore, RunStore } from "@internal/run-store";
import { TtlSystem } from "./systems/ttlSystem.js";
import { WaitpointSystem } from "./systems/waitpointSystem.js";
import {
  EngineWorker,
  HeartbeatTimeouts,
  ReportableQueue,
  RunEngineOptions,
  TriggerParams,
} from "./types.js";
import { createTtlWorkerCatalog } from "./ttlWorkerCatalog.js";
import { workerCatalog } from "./workerCatalog.js";
import pMap from "p-map";

export class RunEngine {
  private runLockRedis: Redis;
  private runLock: RunLocker;
  private worker: EngineWorker;
  private ttlWorker: Worker<ReturnType<typeof createTtlWorkerCatalog>>;
  private logger: Logger;
  private tracer: Tracer;
  private meter: Meter;
  private snapshotsSinceReplicaMissCounter: Counter;
  private snapshotsSinceReplicaRetryDelay: { minMs: number; maxMs: number };
  private heartbeatTimeouts: HeartbeatTimeouts;
  private repairSnapshotTimeoutMs: number;
  private batchQueue: BatchQueue;

  prisma: PrismaClient;
  readOnlyPrisma: PrismaReplicaClient;
  runStore: RunStore;
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
  debounceSystem: DebounceSystem;
  ttlSystem: TtlSystem;
  pendingVersionSystem: PendingVersionSystem;
  raceSimulationSystem: RaceSimulationSystem = new RaceSimulationSystem();

  private readonly billingCache: BillingCache;

  constructor(private readonly options: RunEngineOptions) {
    this.logger = options.logger ?? new Logger("RunEngine", this.options.logLevel ?? "info");
    this.prisma = options.prisma;
    this.readOnlyPrisma = options.readOnlyPrisma ?? this.prisma;
    this.runStore = new PostgresRunStore({ prisma: this.prisma, readOnlyPrisma: this.readOnlyPrisma });
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

    const queueSelectionStrategyOptions = {
      keys,
      redis: { ...options.queue.redis, keyPrefix: `${options.queue.redis.keyPrefix}runqueue:` },
      defaultEnvConcurrencyLimit: options.queue?.defaultEnvConcurrency ?? 10,
      ...options.queue?.queueSelectionStrategyOptions,
    };

    this.logger.log("RunEngine FairQueueSelectionStrategy queueSelectionStrategyOptions", {
      options: queueSelectionStrategyOptions,
    });

    this.runQueue = new RunQueue({
      name: "rq",
      tracer: trace.getTracer("rq"),
      keys,
      queueSelectionStrategy: new FairQueueSelectionStrategy(queueSelectionStrategyOptions),
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
      ttlSystem: options.queue?.ttlSystem?.disabled
        ? undefined
        : {
          shardCount: options.queue?.ttlSystem?.shardCount,
          pollIntervalMs: options.queue?.ttlSystem?.pollIntervalMs,
          batchSize: options.queue?.ttlSystem?.batchSize,
          consumersDisabled: options.queue?.ttlSystem?.consumersDisabled,
          workerQueueSuffix: "ttl-worker:{queue:ttl-expiration:}queue",
          workerItemsSuffix: "ttl-worker:{queue:ttl-expiration:}items",
          visibilityTimeoutMs: options.queue?.ttlSystem?.visibilityTimeoutMs ?? 30_000,
        },
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
        repairSnapshot: async ({ payload }) => {
          await this.#handleRepairSnapshot(payload);
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
            payload.backgroundWorkerId,
            payload.attempt
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

    this.snapshotsSinceReplicaMissCounter = this.meter.createCounter(
      "run_engine.snapshots_since.replica_miss",
      {
        description:
          "getSnapshotsSince reads where the since snapshot was not yet on the read replica, recovered via a replica retry or served from the primary",
      }
    );

    // Normalize the bounds, but keep maxMs <= 0 meaning "skip the replica retry".
    const retryDelay = options.readReplicaSnapshotsSinceRetryDelay ?? { minMs: 50, maxMs: 200 };
    const retryMinMs = Math.max(0, retryDelay.minMs);
    this.snapshotsSinceReplicaRetryDelay = {
      minMs: retryDelay.maxMs > 0 ? Math.min(retryMinMs, retryDelay.maxMs) : retryMinMs,
      maxMs: retryDelay.maxMs,
    };

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

    this.repairSnapshotTimeoutMs = options.repairSnapshotTimeoutMs ?? 60_000;

    const resources: SystemResources = {
      prisma: this.prisma,
      readOnlyPrisma: this.readOnlyPrisma,
      runStore: this.runStore,
      worker: this.worker,
      eventBus: this.eventBus,
      logger: this.logger,
      tracer: this.tracer,
      meter: this.meter,
      runLock: this.runLock,
      runQueue: this.runQueue,
      raceSimulationSystem: this.raceSimulationSystem,
      pendingVersionRunIdLookup:
        options.pendingVersionRunIdLookup ?? new NoopPendingVersionRunIdLookup(),
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

    this.debounceSystem = new DebounceSystem({
      resources,
      redis: options.debounce?.redis ?? options.runLock.redis,
      executionSnapshotSystem: this.executionSnapshotSystem,
      delayedRunSystem: this.delayedRunSystem,
      maxDebounceDurationMs: options.debounce?.maxDebounceDurationMs ?? 60 * 60 * 1000, // Default 1 hour
      quantizeNewDelayUntilMs: options.debounce?.quantizeNewDelayUntilMs ?? 1000,
      fastPathSkipEnabled: options.debounce?.fastPathSkipEnabled ?? true,
      useReplicaForFastPathRead: options.debounce?.useReplicaForFastPathRead ?? false,
    });

    this.pendingVersionSystem = new PendingVersionSystem({
      resources,
      enqueueSystem: this.enqueueSystem,
      queueRunsPendingVersionBatchSize: options.queueRunsWaitingForWorkerBatchSize,
      lagRetryDelayMs: options.pendingVersionLagRetryDelayMs,
      lagMaxRetries: options.pendingVersionLagMaxRetries,
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

    const ttlWorkerCatalog = createTtlWorkerCatalog({
      visibilityTimeoutMs: options.queue?.ttlSystem?.visibilityTimeoutMs,
      batchMaxSize: options.queue?.ttlSystem?.batchMaxSize,
      batchMaxWaitMs: options.queue?.ttlSystem?.batchMaxWaitMs,
    });

    this.ttlWorker = new Worker({
      name: "ttl-expiration",
      redisOptions: {
        ...options.queue.redis,
        keyPrefix: `${options.queue.redis.keyPrefix}runqueue:ttl-worker:`,
      },
      catalog: ttlWorkerCatalog,
      concurrency: { limit: options.queue?.ttlSystem?.workerConcurrency ?? 1 },
      pollIntervalMs: options.worker.pollIntervalMs ?? 1000,
      immediatePollIntervalMs: options.worker.immediatePollIntervalMs ?? 100,
      shutdownTimeoutMs: options.worker.shutdownTimeoutMs ?? 10_000,
      logger: new Logger("RunEngineTtlWorker", options.logLevel ?? "info"),
      jobs: {
        expireTtlRun: async (items) => {
          await this.ttlSystem.expireRunsBatch(items.map((i) => i.payload.runId));
        },
      },
    });

    // Start TTL worker whenever TTL system is enabled, so expired runs enqueued by the
    // Lua script get processed even when the main engine worker is disabled (e.g. in tests).
    if (options.queue?.ttlSystem && !options.queue.ttlSystem.disabled && !options.queue.ttlSystem.consumersDisabled) {
      this.ttlWorker.start();
    }

    this.batchSystem = new BatchSystem({
      resources,
      waitpointSystem: this.waitpointSystem,
    });

    // Initialize BatchQueue for DRR-based batch processing (if configured)
    // Only start consumers if consumerDisabled is not set or is false
    const startBatchQueueConsumers = options.batchQueue?.consumerEnabled ?? true;

    this.batchQueue = new BatchQueue({
      redis: {
        keyPrefix: `${options.batchQueue?.redis.keyPrefix ?? ""}batch-queue:`,
        ...options.batchQueue?.redis,
      },
      drr: {
        quantum: options.batchQueue?.drr?.quantum ?? 5,
        maxDeficit: options.batchQueue?.drr?.maxDeficit ?? 50,
        masterQueueLimit: options.batchQueue?.drr?.masterQueueLimit,
      },
      shardCount: options.batchQueue?.shardCount,
      workerQueueBlockingTimeoutSeconds: options.batchQueue?.workerQueueBlockingTimeoutSeconds,
      consumerCount: options.batchQueue?.consumerCount ?? 2,
      consumerIntervalMs: options.batchQueue?.consumerIntervalMs ?? 100,
      defaultConcurrency: options.batchQueue?.defaultConcurrency ?? 10,
      globalRateLimiter: options.batchQueue?.globalRateLimiter,
      workerQueueMaxDepth: options.batchQueue?.workerQueueMaxDepth,
      startConsumers: startBatchQueueConsumers,
      retry: options.batchQueue?.retry,
      tracer: options.tracer,
      meter: options.meter,
    });

    this.logger.info("BatchQueue initialized", {
      consumerCount: options.batchQueue?.consumerCount ?? 2,
      drrQuantum: options.batchQueue?.drr?.quantum ?? 5,
      defaultConcurrency: options.batchQueue?.defaultConcurrency ?? 10,
      consumersEnabled: startBatchQueueConsumers,
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

  /**
   * Writes a TaskRun row in CANCELED state directly, bypassing the trigger
   * pipeline. Used by the mollifier drainer when a cancel API call lands on
   * a buffered run before it materialises.
   *
   * Skips: queue insertion (no execution), waitpoint creation (the
   * mollifier gate refuses to buffer triggerAndWait children, so a
   * cancelled buffered run never has a waiting parent to unblock),
   * concurrency reservation. Emits `runCancelled` by default — callers
   * working on buffered-only runs (no primary trace event exists) can
   * opt out via `emitRunCancelledEvent: false` to avoid the systematic
   * "Failed to cancel run event" noise the handler would log when its
   * `cancelRunEvent` call can't find a span.
   *
   * Idempotent: if a row with the same friendlyId already exists (double
   * drainer pop after requeue), Prisma's P2002 unique-constraint violation
   * is caught and the existing row is returned. The duplicate runCancelled
   * emission is skipped — the original drain's emit already wrote the
   * TaskEvent (when applicable).
   */
  async createCancelledRun(
    {
      snapshot,
      cancelledAt,
      cancelReason,
      emitRunCancelledEvent = true,
    }: {
      snapshot: TriggerParams;
      cancelledAt: Date;
      cancelReason: string;
      /**
       * Whether to emit the `runCancelled` engine-bus event. Defaults to
       * true.
       *
       * Set to `false` for buffered-only runs that never had a primary
       * trace event written (the mollifier gate never called
       * `repository.traceEvent` for them). The `runCancelled` handler in
       * `runEngineHandlers.server.ts` calls `cancelRunEvent`, which
       * looks up the run's primary span in the event store — for
       * buffered-only runs that span doesn't exist, so the lookup fails,
       * the handler's `tryCatch` swallows it, and a "[runCancelled]
       * Failed to cancel run event" error is logged for every cancelled
       * buffered run. Suppressing the emit avoids that systematic noise.
       * The CANCELED PG row is still written; only the trace-event
       * mirror is skipped.
       */
      emitRunCancelledEvent?: boolean;
    },
    tx?: PrismaClientOrTransaction,
  ): Promise<TaskRun> {
    const prisma = tx ?? this.prisma;
    return startSpan(this.tracer, "createCancelledRun", async (span) => {
      span.setAttribute("friendlyId", snapshot.friendlyId);
      span.setAttribute("taskIdentifier", snapshot.taskIdentifier);
      const id = RunId.fromFriendlyId(snapshot.friendlyId);
      const error: TaskRunError = { type: "STRING_ERROR", raw: cancelReason };

      try {
        const taskRun = await this.runStore.createCancelledRun(
          {
            data: {
              id,
              engine: "V2",
              status: "CANCELED",
              friendlyId: snapshot.friendlyId,
              runtimeEnvironmentId: snapshot.environment.id,
              environmentType: snapshot.environment.type,
              organizationId: snapshot.environment.organization.id,
              projectId: snapshot.environment.project.id,
              idempotencyKey: snapshot.idempotencyKey,
              idempotencyKeyExpiresAt: snapshot.idempotencyKeyExpiresAt,
              idempotencyKeyOptions: snapshot.idempotencyKeyOptions,
              taskIdentifier: snapshot.taskIdentifier,
              payload: snapshot.payload,
              payloadType: snapshot.payloadType,
              context: snapshot.context,
              traceContext: snapshot.traceContext,
              traceId: snapshot.traceId,
              spanId: snapshot.spanId,
              parentSpanId: snapshot.parentSpanId,
              lockedToVersionId: snapshot.lockedToVersionId,
              taskVersion: snapshot.taskVersion,
              sdkVersion: snapshot.sdkVersion,
              cliVersion: snapshot.cliVersion,
              concurrencyKey: snapshot.concurrencyKey,
              queue: snapshot.queue,
              lockedQueueId: snapshot.lockedQueueId,
              workerQueue: snapshot.workerQueue,
              isTest: snapshot.isTest,
              taskEventStore: snapshot.taskEventStore,
              // Defensive: the snapshot comes from a cjson-encoded buffer
              // payload, where empty Lua tables encode as `{}` not `[]`. If
              // the drainer pops a buffered run with no tags, snapshot.tags
              // will be an empty object, which Prisma misreads as a relation
              // update op. Normalise to a real array (or undefined for the
              // empty case).
              runTags: Array.isArray(snapshot.tags) && snapshot.tags.length > 0
                ? snapshot.tags
                : undefined,
              oneTimeUseToken: snapshot.oneTimeUseToken,
              parentTaskRunId: snapshot.parentTaskRunId,
              rootTaskRunId: snapshot.rootTaskRunId,
              replayedFromTaskRunFriendlyId: snapshot.replayedFromTaskRunFriendlyId,
              batchId: snapshot.batch?.id,
              resumeParentOnCompletion: snapshot.resumeParentOnCompletion,
              depth: snapshot.depth,
              seedMetadata: snapshot.seedMetadata,
              seedMetadataType: snapshot.seedMetadataType,
              metadata: snapshot.metadata,
              metadataType: snapshot.metadataType,
              machinePreset: snapshot.machine,
              scheduleId: snapshot.scheduleId,
              scheduleInstanceId: snapshot.scheduleInstanceId,
              createdAt: snapshot.createdAt,
              bulkActionGroupIds: snapshot.bulkActionId ? [snapshot.bulkActionId] : undefined,
              planType: snapshot.planType,
              realtimeStreamsVersion: snapshot.realtimeStreamsVersion,
              streamBasinName: snapshot.streamBasinName,
              annotations: snapshot.annotations,
              completedAt: cancelledAt,
              updatedAt: cancelledAt,
              error: error as unknown as Prisma.InputJsonValue,
              attemptNumber: 0,
            },
            snapshot: {
              engine: "V2",
              executionStatus: "FINISHED",
              description: "Run cancelled before materialisation",
              runStatus: "CANCELED",
              environmentId: snapshot.environment.id,
              environmentType: snapshot.environment.type,
              projectId: snapshot.environment.project.id,
              organizationId: snapshot.environment.organization.id,
            },
          },
          prisma
        );

        if (emitRunCancelledEvent) {
          this.eventBus.emit("runCancelled", {
            time: cancelledAt,
            run: {
              id: taskRun.id,
              status: taskRun.status,
              friendlyId: taskRun.friendlyId,
              spanId: taskRun.spanId,
              taskEventStore: taskRun.taskEventStore,
              createdAt: taskRun.createdAt,
              completedAt: taskRun.completedAt,
              error,
              updatedAt: taskRun.updatedAt,
              attemptNumber: taskRun.attemptNumber ?? 0,
            },
            organization: { id: snapshot.environment.organization.id },
            project: { id: snapshot.environment.project.id },
            environment: { id: snapshot.environment.id },
          });
        }

        return taskRun;
      } catch (err) {
        // P2002 = unique constraint violation. Double-pop after a drainer
        // requeue can reach this. Idempotent: return the existing row
        // without re-emitting.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          this.logger.info(
            "createCancelledRun: row already exists, returning existing (idempotent)",
            { friendlyId: snapshot.friendlyId },
          );
          const existing = await prisma.taskRun.findFirst({ where: { id } });
          if (existing) {
            // Only treat the conflict as idempotent when the existing
            // row is ALREADY canceled. If a non-canceled row landed
            // first (e.g. the drainer's normal `engine.trigger` replay
            // path raced ahead of the cancel) we surface a conflict
            // rather than silently reporting "cancelled" — the run is
            // genuinely live and the caller must decide between
            // engine.cancelRun() and skipping.
            if (existing.status === "CANCELED") {
              return existing;
            }
            throw new Error(
              `createCancelledRun conflict: existing run ${snapshot.friendlyId} has status ${existing.status}`,
            );
          }
        }
        throw err;
      }
    });
  }

  /** "Triggers" one run. */
  async trigger(
    {
      friendlyId,
      environment,
      idempotencyKey,
      idempotencyKeyExpiresAt,
      idempotencyKeyOptions,
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
      region,
      enableFastPath,
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
      realtimeStreamsVersion,
      streamBasinName,
      debounce,
      annotations,
      onDebounced,
    }: TriggerParams,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    const prisma = tx ?? this.prisma;

    return startSpan(
      this.tracer,
      "trigger",
      async (span) => {
        // Handle debounce before creating a new run
        // Store claimId if we successfully claimed the debounce key
        let debounceClaimId: string | undefined;

        if (debounce) {
          const debounceResult = await this.debounceSystem.handleDebounce({
            environmentId: environment.id,
            taskIdentifier,
            debounce:
              debounce.mode === "trailing"
                ? {
                  ...debounce,
                  updateData: {
                    payload,
                    payloadType,
                    metadata,
                    metadataType,
                    tags,
                    maxAttempts,
                    maxDurationInSeconds,
                    machine,
                  },
                }
                : debounce,
            tx: prisma,
          });

          if (debounceResult.status === "existing") {
            span.setAttribute("debounced", true);
            span.setAttribute("existingRunId", debounceResult.run.id);

            // For triggerAndWait, block the parent run with the existing run's waitpoint
            if (resumeParentOnCompletion && parentTaskRunId) {
              // Get or create waitpoint lazily (existing run may not have one if it was standalone)
              let waitpoint = debounceResult.waitpoint;
              if (!waitpoint) {
                waitpoint = await this.waitpointSystem.getOrCreateRunWaitpoint({
                  runId: debounceResult.run.id,
                  projectId: environment.project.id,
                  environmentId: environment.id,
                });
              }

              // Call the onDebounced callback to create a span and get spanIdToComplete
              let spanIdToComplete: string | undefined;
              if (onDebounced) {
                spanIdToComplete = await onDebounced({
                  existingRun: debounceResult.run,
                  waitpoint,
                  debounceKey: debounce.key,
                });
              }

              await this.waitpointSystem.blockRunWithWaitpoint({
                runId: parentTaskRunId,
                waitpoints: waitpoint.id,
                spanIdToComplete,
                projectId: environment.project.id,
                organizationId: environment.organization.id,
                batch,
                workerId,
                runnerId,
                tx: prisma,
              });
            }

            return debounceResult.run;
          }

          // If max_duration_exceeded, we continue to create a new run without debouncing
          if (debounceResult.status === "max_duration_exceeded") {
            span.setAttribute("debounceMaxDurationExceeded", true);
          }

          // Store the claimId for later registration
          if (debounceResult.status === "new" && debounceResult.claimId) {
            debounceClaimId = debounceResult.claimId;
            span.setAttribute("debounceClaimId", debounceClaimId);
          }
        }

        const status = delayUntil ? "DELAYED" : "PENDING";

        // Apply defaultMaxTtl: use as default when no TTL is provided, clamp when larger
        const resolvedTtl = this.#resolveMaxTtl(ttl);

        //create run
        let taskRun: TaskRun & { associatedWaitpoint: Waitpoint | null };
        const taskRunId = RunId.fromFriendlyId(friendlyId);
        try {
          taskRun = await this.runStore.createRun(
            {
              data: {
                id: taskRunId,
                engine: "V2",
                status,
                friendlyId,
                runtimeEnvironmentId: environment.id,
                environmentType: environment.type,
                organizationId: environment.organization.id,
                projectId: environment.project.id,
                idempotencyKey,
                idempotencyKeyExpiresAt,
                idempotencyKeyOptions,
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
                region,
                isTest,
                delayUntil,
                queuedAt,
                maxAttempts,
                taskEventStore,
                priorityMs,
                queueTimestamp: queueTimestamp ?? delayUntil ?? new Date(),
                ttl: resolvedTtl,
                // Defensive: when the mollifier drainer replays a buffered
                // snapshot whose payload was rewritten by a buffer-side Lua
                // mutate (e.g. append_tags clears an empty list), cjson
                // encodes an empty Lua table as `{}` rather than `[]`. JS
                // parses that back as an empty object, and `{}.length` is
                // undefined — the original `tags.length === 0` check would
                // pass `{}` straight to Prisma's `String[]` column. Mirror
                // the same Array.isArray guard that `createCancelledRun`
                // uses for symmetry with the trigger replay path.
                runTags: Array.isArray(tags) && tags.length > 0 ? tags : undefined,
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
                realtimeStreamsVersion,
                streamBasinName,
                debounce: debounce
                  ? {
                    key: debounce.key,
                    delay: debounce.delay,
                    createdAt: new Date(),
                  }
                  : undefined,
                annotations,
              },
              snapshot: {
                engine: "V2",
                executionStatus: delayUntil ? "DELAYED" : "RUN_CREATED",
                description: delayUntil ? "Run is delayed" : "Run was created",
                runStatus: status,
                environmentId: environment.id,
                environmentType: environment.type,
                projectId: environment.project.id,
                organizationId: environment.organization.id,
                workerId,
                runnerId,
              },
              // Only create waitpoint if parent is waiting for this run to complete
              // For standalone triggers (no waiting parent), waitpoint is created lazily if needed later
              associatedWaitpoint:
                resumeParentOnCompletion && parentTaskRunId
                  ? this.waitpointSystem.buildRunAssociatedWaitpoint({
                    projectId: environment.project.id,
                    environmentId: environment.id,
                  })
                  : undefined,
            },
            prisma
          );
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
              const target = (error.meta as Record<string, unknown>)?.target;
              const targetFields = Array.isArray(target) ? target : [];

              this.logger.debug("engine.trigger(): P2002 unique constraint violation", {
                code: error.code,
                message: error.message,
                meta: error.meta,
                target: targetFields,
                idempotencyKey,
                environmentId: environment.id,
              });

              if (targetFields.includes("oneTimeUseToken")) {
                throw new RunOneTimeUseTokenError(
                  `One-time use token has already been used`
                );
              }

              // Only idempotency key collisions should be retried
              throw new RunDuplicateIdempotencyKeyError(
                `Run with idempotency key ${idempotencyKey} already exists`
              );
            }
          }

          throw error;
        }

        span.setAttribute("runId", taskRun.id);

        //triggerAndWait or batchTriggerAndWait
        if (resumeParentOnCompletion && parentTaskRunId && taskRun.associatedWaitpoint) {
          if (batch) {
            // Batch path: lockless insert. The parent is already EXECUTING_WITH_WAITPOINTS
            // from blockRunWithCreatedBatch, so we only need to insert the TaskRunWaitpoint
            // row without acquiring the parent run lock. This avoids lock contention when
            // processing large batches with high concurrency.
            await this.waitpointSystem.blockRunWithWaitpointLockless({
              runId: parentTaskRunId,
              waitpoints: taskRun.associatedWaitpoint.id,
              projectId: taskRun.associatedWaitpoint.projectId,
              batch,
              tx: prisma,
            });
          } else {
            // Single triggerAndWait: acquire the parent run lock to safely transition
            // the snapshot and insert the waitpoint
            await this.waitpointSystem.blockRunWithWaitpoint({
              runId: parentTaskRunId,
              waitpoints: taskRun.associatedWaitpoint.id,
              projectId: taskRun.associatedWaitpoint.projectId,
              organizationId: environment.organization.id,
              batch,
              workerId,
              runnerId,
              tx: prisma,
            });
          }
        }

        if (taskRun.delayUntil) {
          // Schedule the run to be enqueued at the delayUntil time
          await this.delayedRunSystem.scheduleDelayedRunEnqueuing({
            runId: taskRun.id,
            delayUntil: taskRun.delayUntil,
          });

          // Register debounced run in Redis for future lookups
          if (debounce) {
            const registered = await this.debounceSystem.registerDebouncedRun({
              runId: taskRun.id,
              environmentId: environment.id,
              taskIdentifier,
              debounceKey: debounce.key,
              delayUntil: taskRun.delayUntil,
              claimId: debounceClaimId,
            });

            if (!registered) {
              // We lost the claim - this shouldn't normally happen, but log it
              this.logger.warn("trigger: lost debounce claim after creating run", {
                runId: taskRun.id,
                debounceKey: debounce.key,
                claimId: debounceClaimId,
              });
            }
          }
        } else {
          try {
            // The new batch TTL path only expires runs still in the queue
            // sorted set (waiting on a concurrency slot). For DEV
            // environments where the dev CLI may not be running, fast-pathed
            // runs can sit on the worker queue indefinitely and never get
            // claimed for expiration. Keep the legacy per-run expireRun job
            // armed for DEV so those runs still expire.
            if (taskRun.ttl && environment.type === "DEVELOPMENT") {
              await this.ttlSystem.scheduleExpireRun({ runId: taskRun.id, ttl: taskRun.ttl });
            }

            await this.enqueueSystem.enqueueRun({
              run: taskRun,
              env: environment,
              workerId,
              runnerId,
              tx: prisma,
              skipRunLock: true,
              includeTtl: true,
              enableFastPath,
            });
          } catch (enqueueError) {
            this.logger.error("engine.trigger(): failed to enqueue run", {
              runId: taskRun.id,
              friendlyId: taskRun.friendlyId,
              taskIdentifier: taskRun.taskIdentifier,
              environmentId: environment.id,
              ttl: taskRun.ttl,
              error: enqueueError,
            });

            throw enqueueError;
          }
        }

        this.eventBus.emit("runCreated", {
          time: new Date(),
          run: {
            id: taskRun.id,
            runTags: taskRun.runTags,
            batchId: taskRun.batchId,
          },
          environment: {
            id: environment.id,
          },
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
   * Creates a pre-failed TaskRun in SYSTEM_FAILURE status.
   *
   * Used when a batch item fails to trigger (e.g., queue limits, environment not found).
   * Creates the run record so batch completion can track it, and if the batch has a
   * waiting parent, creates and immediately completes a RUN waitpoint with the error.
   */
  async createFailedTaskRun({
    friendlyId,
    environment,
    taskIdentifier,
    payload,
    payloadType,
    error,
    parentTaskRunId,
    rootTaskRunId,
    depth,
    resumeParentOnCompletion,
    batch,
    traceId,
    spanId,
    traceContext,
    taskEventStore,
    queue: queueOverride,
    lockedQueueId: lockedQueueIdOverride,
    emitRunFailedEvent = true,
  }: {
    friendlyId: string;
    environment: {
      id: string;
      type: RuntimeEnvironmentType;
      project: { id: string };
      organization: { id: string };
    };
    taskIdentifier: string;
    payload?: string;
    payloadType?: string;
    error: TaskRunError;
    parentTaskRunId?: string;
    /** The root run of the task tree. If the parent is already a child, this is the parent's root. */
    rootTaskRunId?: string;
    /** Depth in the task tree (0 for root, parentDepth+1 for children). */
    depth?: number;
    resumeParentOnCompletion?: boolean;
    batch?: { id: string; index: number };
    traceId?: string;
    spanId?: string;
    traceContext?: Record<string, unknown>;
    taskEventStore?: string;
    /** Resolved queue name (e.g. custom queue). When provided, used instead of task/${taskIdentifier}. */
    queue?: string;
    /** Resolved TaskQueue.id when the task is locked to a specific queue. */
    lockedQueueId?: string;
    /**
     * Whether to emit the `runFailed` engine-bus event. Defaults to true.
     *
     * Set to `false` when the caller is ALREADY managing the trace-event
     * lifecycle for this run via `repository.traceEvent({ incomplete: false,
     * isError: true, ... })`. In that path the outer trace event handles
     * span completion itself; emitting `runFailed` from here causes the
     * `runFailed` → `completeFailedRunEvent` handler to write a second
     * completion row for the same (traceId, spanId), racing with the
     * outer trace event's own write. The alert side of `runFailed` is
     * preserved by emitting from the caller after `traceEvent` returns.
     */
    emitRunFailedEvent?: boolean;
  }): Promise<TaskRun> {
    return startSpan(
      this.tracer,
      "createFailedTaskRun",
      async (span) => {
        const taskRunId = RunId.fromFriendlyId(friendlyId);

        // Build associated waitpoint data if parent is waiting for this run
        const waitpointData =
          resumeParentOnCompletion && parentTaskRunId
            ? this.waitpointSystem.buildRunAssociatedWaitpoint({
              projectId: environment.project.id,
              environmentId: environment.id,
            })
            : undefined;

        // Create the run in terminal SYSTEM_FAILURE status.
        // No execution snapshot is needed: this run never gets dequeued, executed,
        // or heartbeated, so nothing will call getLatestExecutionSnapshot on it.
        const taskRun = await this.runStore.createFailedRun(
          {
            data: {
              id: taskRunId,
              engine: "V2",
              status: "SYSTEM_FAILURE",
              friendlyId,
              runtimeEnvironmentId: environment.id,
              environmentType: environment.type,
              organizationId: environment.organization.id,
              projectId: environment.project.id,
              taskIdentifier,
              payload: payload ?? "",
              payloadType: payloadType ?? "application/json",
              context: {},
              traceContext: (traceContext ?? {}) as Record<string, string | undefined>,
              traceId: traceId ?? "",
              spanId: spanId ?? "",
              queue: queueOverride ?? `task/${taskIdentifier}`,
              lockedQueueId: lockedQueueIdOverride,
              isTest: false,
              completedAt: new Date(),
              error: error as unknown as Prisma.InputJsonObject,
              parentTaskRunId,
              rootTaskRunId,
              depth: depth ?? 0,
              batchId: batch?.id,
              resumeParentOnCompletion,
              taskEventStore,
            },
            associatedWaitpoint: waitpointData,
          },
          this.prisma
        );

        span.setAttribute("runId", taskRun.id);

        // If parent is waiting, block it with the waitpoint then immediately
        // complete it with the error output so the parent can resume.
        if (
          resumeParentOnCompletion &&
          parentTaskRunId &&
          taskRun.associatedWaitpoint
        ) {
          await this.waitpointSystem.blockRunAndCompleteWaitpoint({
            runId: parentTaskRunId,
            waitpointId: taskRun.associatedWaitpoint.id,
            output: { value: JSON.stringify(error), isError: true },
            projectId: environment.project.id,
            organizationId: environment.organization.id,
            batch,
          });
        }

        // Emit `runFailed` so the alert pipeline picks up the
        // SYSTEM_FAILURE row and the event-store handler writes the
        // completion event into the trace. Without this the mollifier
        // drainer's terminal failures (and batch-trigger's
        // exceed-limit failures) land in PG silently — visible in the
        // dashboard list but never reaching customers' configured
        // ERROR alert channels.
        //
        // Gated by `emitRunFailedEvent` so call sites that already wrap
        // this inside `repository.traceEvent({ incomplete: false,
        // isError: true })` can opt out — the outer trace event writes
        // the completion row itself, and a second write via
        // `completeFailedRunEvent` would race against it. Callers that
        // disable the emit are responsible for triggering the alerts
        // side themselves (e.g. by calling
        // `PerformTaskRunAlertsService.enqueue` directly after the
        // trace event closes).
        if (!emitRunFailedEvent) {
          return taskRun;
        }
        this.eventBus.emit("runFailed", {
          time: taskRun.completedAt ?? new Date(),
          run: {
            id: taskRun.id,
            status: taskRun.status,
            spanId: taskRun.spanId,
            error,
            taskEventStore: taskRun.taskEventStore,
            createdAt: taskRun.createdAt,
            completedAt: taskRun.completedAt,
            updatedAt: taskRun.updatedAt,
            // This row never attempted execution — it's a synthesised
            // terminal failure. The alert payload's `attemptNumber=0`
            // is the signal downstream consumers can use to
            // distinguish a never-ran failure from a run that
            // exhausted its retries.
            attemptNumber: 0,
            usageDurationMs: 0,
            costInCents: 0,
          },
          organization: {
            id: environment.organization.id,
          },
          project: {
            id: environment.project.id,
          },
          environment: {
            id: environment.id,
          },
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

  async lengthOfQueue(environment: MinimalAuthenticatedEnvironment, queue: string): Promise<number> {
    return this.runQueue.lengthOfQueue(environment, queue);
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

  // ============================================================================
  // BatchQueue methods (DRR-based batch processing)
  // ============================================================================

  /**
   * Set the callback for processing batch items.
   * This is called for each item dequeued from the batch queue.
   */
  setBatchProcessItemCallback(callback: ProcessBatchItemCallback): void {
    this.batchQueue.onProcessItem(callback);
  }

  /**
   * Set the callback for batch completion.
   * This is called when all items in a batch have been processed.
   */
  setBatchCompletionCallback(callback: BatchCompletionCallback): void {
    this.batchQueue.onBatchComplete(callback);
  }

  /**
   * Get the remaining count of items in a batch.
   */
  async getBatchQueueRemainingCount(batchId: string): Promise<number> {
    return this.batchQueue.getBatchRemainingCount(batchId);
  }

  /**
   * Get the live progress for a batch from Redis.
   * Returns success count, failure count, and processed count.
   * This is useful for displaying real-time progress in the UI without
   * hitting the database.
   */
  async getBatchQueueProgress(batchId: string): Promise<{
    successCount: number;
    failureCount: number;
    processedCount: number;
  } | null> {
    return this.batchQueue.getBatchProgress(batchId);
  }

  // ============================================================================
  // Batch Queue - 2-Phase API (v3)
  // ============================================================================

  /**
   * Initialize a batch for 2-phase processing (Phase 1).
   *
   * This stores batch metadata in Redis WITHOUT enqueueing any items.
   * Items are streamed separately via enqueueBatchItem().
   *
   * Use this for the v3 streaming batch API where items are sent via NDJSON stream.
   */
  async initializeBatch(options: InitializeBatchOptions): Promise<void> {
    return this.batchQueue.initializeBatch(options);
  }

  /**
   * Enqueue a single item to an existing batch (Phase 2).
   *
   * This is used for streaming batch item ingestion in the v3 API.
   * Returns whether the item was enqueued (true) or deduplicated (false).
   *
   * @param batchId - The batch ID (internal format)
   * @param envId - The environment ID (needed for queue routing)
   * @param itemIndex - Zero-based index of this item
   * @param item - The batch item to enqueue
   * @returns Object with enqueued status
   */
  async enqueueBatchItem(
    batchId: string,
    envId: string,
    itemIndex: number,
    item: BatchItem
  ): Promise<{ enqueued: boolean }> {
    return this.batchQueue.enqueueBatchItem(batchId, envId, itemIndex, item);
  }

  /**
   * Get the count of items that have been enqueued for a batch.
   * Useful for progress tracking during streaming ingestion.
   */
  async getBatchEnqueuedCount(batchId: string): Promise<number> {
    return this.batchQueue.getEnqueuedCount(batchId);
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
   * Gets an existing run waitpoint or creates one lazily.
   * Used for debounce/idempotency when a late-arriving triggerAndWait caller
   * needs to block on an existing run that was created without a waitpoint.
   * When the run has already completed, creates the waitpoint and immediately
   * completes it with the run's output/error so the parent can resume.
   */
  async getOrCreateRunWaitpoint({
    runId,
    projectId,
    environmentId,
  }: {
    runId: string;
    projectId: string;
    environmentId: string;
  }): Promise<Waitpoint> {
    return this.waitpointSystem.getOrCreateRunWaitpoint({
      runId,
      projectId,
      environmentId,
    });
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
    const useReplica =
      !tx &&
      this.options.readReplicaSnapshotsSinceEnabled === true &&
      this.readOnlyPrisma !== this.prisma;
    const prisma = tx ?? (useReplica ? this.readOnlyPrisma : this.prisma);

    const query = async (client: PrismaClientOrTransaction) => {
      const snapshots = await getExecutionSnapshotsSince(client, runId, snapshotId);
      return snapshots.map(executionDataFromSnapshot);
    };

    try {
      return await query(prisma);
    } catch (e) {
      if (useReplica && e instanceof ExecutionSnapshotNotFoundError) {
        // Replica lag: the runner learned this snapshot id from the writer before the
        // replica caught up. Give the replica one jittered retry; if it's still missing,
        // serve from the writer. Only not-found errors get this treatment - any other
        // replica failure stays an error rather than shifting read load to the writer.
        // A miss on the writer too is a real error, not lag.
        const { minMs, maxMs } = this.snapshotsSinceReplicaRetryDelay;
        if (maxMs > 0) {
          await setTimeout(minMs + Math.random() * Math.max(0, maxMs - minMs));
          try {
            const result = await query(this.readOnlyPrisma);
            this.snapshotsSinceReplicaMissCounter.add(1, { outcome: "replica_retry" });
            return result;
          } catch (replicaRetryError) {
            if (!(replicaRetryError instanceof ExecutionSnapshotNotFoundError)) {
              this.logger.error("Failed to getSnapshotsSince", {
                message:
                  replicaRetryError instanceof Error
                    ? replicaRetryError.message
                    : replicaRetryError,
                runId,
                snapshotId,
                failedDuring: "replica_retry",
              });
              return null;
            }
            // still not on the replica - fall through to the primary
          }
        }

        try {
          const result = await query(this.prisma);
          this.snapshotsSinceReplicaMissCounter.add(1, { outcome: "primary" });
          this.logger.warn("getSnapshotsSince: snapshot not yet on replica, served from primary", {
            runId,
            snapshotId,
          });
          return result;
        } catch (retryError) {
          this.logger.error("Failed to getSnapshotsSince", {
            message: retryError instanceof Error ? retryError.message : retryError,
            runId,
            snapshotId,
            failedDuring: "primary_fallback",
          });
          return null;
        }
      }

      this.logger.error("Failed to getSnapshotsSince", {
        message: e instanceof Error ? e.message : e,
        runId,
        snapshotId,
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
      await this.ttlWorker.stop();
      await this.runLock.quit();

      // This is just a failsafe
      await this.runLockRedis.quit();

      // Close the batch queue and its Redis connections
      await this.batchQueue.close();

      // Close the debounce system Redis connection
      await this.debounceSystem.quit();
    } catch (error) {
      // And should always throw
    }
  }

  async repairEnvironment(environment: AuthenticatedEnvironment, dryRun: boolean) {
    const runIds = await this.runQueue.getCurrentConcurrencyOfEnvironment(environment);

    return this.#repairRuns(runIds, dryRun);
  }

  async repairQueue(
    environment: AuthenticatedEnvironment,
    queue: string,
    dryRun: boolean,
    ignoreRunIds: string[]
  ) {
    const runIds = await this.runQueue.getCurrentConcurrencyOfQueue(environment, queue);

    const runIdsToRepair = runIds.filter((runId) => !ignoreRunIds.includes(runId));

    return this.#repairRuns(runIdsToRepair, dryRun);
  }

  async #repairRuns(runIds: string[], dryRun: boolean) {
    if (runIds.length === 0) {
      return {
        runIds,
        repairs: [],
        dryRun,
      };
    }

    const repairs = await pMap(
      runIds,
      async (runId) => {
        return this.#repairRun(runId, dryRun);
      },
      { concurrency: 5 }
    );

    return {
      runIds,
      repairs,
      dryRun,
    };
  }

  async #repairRun(runId: string, dryRun: boolean) {
    const snapshot = await getLatestExecutionSnapshot(this.prisma, runId);

    if (
      snapshot.executionStatus === "QUEUED" ||
      snapshot.executionStatus === "SUSPENDED" ||
      snapshot.executionStatus === "FINISHED"
    ) {
      if (!dryRun) {
        // Schedule the repair job
        await this.worker.enqueueOnce({
          id: `repair-in-progress-run:${runId}`,
          job: "repairSnapshot",
          payload: { runId, snapshotId: snapshot.id, executionStatus: snapshot.executionStatus },
          availableAt: new Date(Date.now() + this.repairSnapshotTimeoutMs),
        });
      }

      return {
        action: "repairSnapshot",
        runId,
        snapshotStatus: snapshot.executionStatus,
        snapshotId: snapshot.id,
      };
    }

    return {
      action: "ignore",
      runId,
      snapshotStatus: snapshot.executionStatus,
      snapshotId: snapshot.id,
    };
  }

  async generateEnvironmentReport(
    environment: AuthenticatedEnvironment,
    queues: ReportableQueue[],
    verbose: boolean
  ) {
    const [
      concurrencyLimit, // env limit (no burst)
      concurrencyLimitWithBurstFactor, // env limit * burst
      currentDequeued,
      currentConcurrency,
      burstFactor,
    ] = await Promise.all([
      this.runQueue.getEnvConcurrencyLimit(environment),
      this.runQueue.getEnvConcurrencyLimitWithBurstFactor(environment),
      this.runQueue.currentConcurrencyOfEnvironment(environment), // "currentDequeued" in your label terminology
      this.runQueue.operationalCurrentConcurrencyOfEnvironment(environment),
      this.runQueue.getEnvConcurrencyBurstFactor(environment),
    ]);

    const envMetrics = {
      envCurrent: currentConcurrency,
      envLimit: concurrencyLimit,
      envLimitWithBurst: concurrencyLimitWithBurstFactor,
      burstFactor,
    };

    const envAnalysis = analyzeEnvironment(envMetrics);

    const queueReports = await pMap(
      queues,
      async (queue) => {
        return this.#generateReportForQueue(environment, queue, envMetrics, verbose);
      },
      { concurrency: 5 }
    );

    return {
      concurrencyLimit: {
        value: concurrencyLimit,
        key: verbose ? this.runQueue.keys.envConcurrencyLimitKey(environment) : undefined,
      },
      concurrencyLimitWithBurstFactor: {
        value: concurrencyLimitWithBurstFactor,
        key: verbose
          ? this.runQueue.keys.envConcurrencyLimitBurstFactorKey(environment)
          : undefined,
      },
      currentDequeued: {
        value: currentDequeued,
        key: verbose ? this.runQueue.keys.envCurrentDequeuedKey(environment) : undefined,
        label: "Env current dequeued, this is what is displayed to the user",
      },
      currentConcurrency: {
        value: currentConcurrency,
        key: verbose ? this.runQueue.keys.envCurrentConcurrencyKey(environment) : undefined,
        label:
          "Env current concurrency, this is what is used to determine if the environment can be dequeued from",
      },
      analysis: envAnalysis,
      queues: queueReports,
    };
  }

  async #generateReportForQueue(
    environment: AuthenticatedEnvironment,
    queue: ReportableQueue,
    envMetrics: EnvInputs,
    verbose: boolean
  ) {
    const currentConcurrency = await this.runQueue.currentConcurrencyOfQueue(
      environment,
      queue.name
    );
    const currentDequeued = await this.runQueue.currentDequeuedOfQueue(environment, queue.name);
    const concurrencyLimit = await this.runQueue.getQueueConcurrencyLimit(environment, queue.name);
    const messagesDueCount = await this.runQueue.lengthOfQueueAvailableMessages(
      environment,
      queue.name
    );

    const queueAnalysis = analyzeQueue({
      paused: queue.paused === true,
      envLimit: envMetrics.envLimit,
      envLimitWithBurst: envMetrics.envLimitWithBurst,
      queueLimit: typeof concurrencyLimit === "number" ? concurrencyLimit : undefined,
      queueCurrent: currentConcurrency,
      envCurrent: envMetrics.envCurrent,
      dueCount: messagesDueCount,
    });

    return {
      name: queue.name,
      friendlyId: queue.friendlyId,
      type: queue.type,
      paused: queue.paused,
      dbConcurrencyLimit: queue.concurrencyLimit,
      key: this.runQueue.keys.queueKey(environment, queue.name),
      analysis: queueAnalysis,
      concurrencyLimit: {
        value: typeof concurrencyLimit === "number" ? concurrencyLimit : null,
        key: verbose
          ? this.runQueue.keys.queueConcurrencyLimitKey(environment, queue.name)
          : undefined,
      },
      currentConcurrency: {
        value: currentConcurrency,
        key: verbose
          ? this.runQueue.keys.queueCurrentConcurrencyKey(environment, queue.name)
          : undefined,
      },
      currentDequeued: {
        value: currentDequeued,
        key: verbose
          ? this.runQueue.keys.queueCurrentDequeuedKey(environment, queue.name)
          : undefined,
      },
    };
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
          this.logger.log("RunEngine stalled snapshot PENDING_EXECUTING", {
            runId,
            snapshotId: latestSnapshot.id,
          });

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
            completedWaitpoints: latestSnapshot.completedWaitpoints,
            batchId: latestSnapshot.batchId ?? undefined,
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
        case "DELAYED": {
          throw new NotImplementedError("There shouldn't be a heartbeat for DELAYED");
        }
        default: {
          assertNever(latestSnapshot.executionStatus);
        }
      }
    });
  }

  async #handleRepairSnapshot({
    runId,
    snapshotId,
    executionStatus,
  }: {
    runId: string;
    snapshotId: string;
    executionStatus: string;
  }) {
    return await this.runLock.lock("handleRepairSnapshot", [runId], async () => {
      const latestSnapshot = await getLatestExecutionSnapshot(this.prisma, runId);

      if (latestSnapshot.id !== snapshotId) {
        this.logger.log(
          "RunEngine.handleRepairSnapshot no longer the latest snapshot, stopping the repair.",
          {
            runId,
            snapshotId,
            latestSnapshotExecutionStatus: latestSnapshot.executionStatus,
            repairExecutionStatus: executionStatus,
          }
        );

        return;
      }

      // Okay, so this means we haven't transitioned to a new status yes, so we need to do something
      switch (latestSnapshot.executionStatus) {
        case "EXECUTING":
        case "EXECUTING_WITH_WAITPOINTS":
        case "PENDING_CANCEL":
        case "PENDING_EXECUTING":
        case "QUEUED_EXECUTING":
        case "RUN_CREATED":
        case "DELAYED": {
          // Do nothing;
          return;
        }
        case "QUEUED": {
          this.logger.log("RunEngine.handleRepairSnapshot QUEUED", {
            runId,
            snapshotId,
          });

          //it will automatically be requeued X times depending on the queue retry settings
          const gotRequeued = await this.runQueue.nackMessage({
            orgId: latestSnapshot.organizationId,
            messageId: runId,
          });

          if (!gotRequeued) {
            this.logger.error("RunEngine.handleRepairSnapshot QUEUED repair failed", {
              runId,
              snapshot: latestSnapshot,
            });
          } else {
            this.logger.log("RunEngine.handleRepairSnapshot QUEUED repair successful", {
              runId,
              snapshot: latestSnapshot,
            });
          }

          break;
        }
        case "FINISHED":
        case "SUSPENDED": {
          this.logger.log("RunEngine.handleRepairSnapshot SUSPENDED/FINISHED", {
            runId,
            snapshotId,
          });

          const taskRun = await this.prisma.taskRun.findFirst({
            where: { id: runId },
            select: {
              queue: true,
            },
          });

          if (!taskRun) {
            this.logger.error(
              "RunEngine.handleRepairSnapshot SUSPENDED/FINISHED task run not found",
              {
                runId,
                snapshotId,
              }
            );
            return;
          }

          // We need to clear this run from the current concurrency sets
          await this.runQueue.clearMessageFromConcurrencySets({
            runId,
            orgId: latestSnapshot.organizationId,
            queue: taskRun.queue,
            env: {
              id: latestSnapshot.environmentId,
              type: latestSnapshot.environmentType,
              project: {
                id: latestSnapshot.projectId,
              },
              organization: {
                id: latestSnapshot.organizationId,
              },
            },
          });

          break;
        }
        default: {
          assertNever(latestSnapshot.executionStatus);
        }
      }
    });
  }

  /**
   * Applies `defaultMaxTtl` to a run's TTL:
   * - No max configured → pass through as-is.
   * - No TTL on the run → use the max as the default.
   * - Both exist → clamp to the smaller value.
   */
  #resolveMaxTtl(ttl: string | undefined): string | undefined {
    const maxTtl = this.options.defaultMaxTtl;

    if (!maxTtl) {
      return ttl;
    }

    if (!ttl) {
      return maxTtl;
    }

    const ttlMs = parseNaturalLanguageDurationInMs(ttl);
    const maxTtlMs = parseNaturalLanguageDurationInMs(maxTtl);

    if (maxTtlMs === undefined) {
      return ttl;
    }

    if (ttlMs === undefined) {
      return maxTtl;
    }

    return ttlMs <= maxTtlMs ? ttl : maxTtl;
  }

  async #concurrencySweeperCallback(
    runIds: string[],
    completedAtOffsetMs: number = 1000 * 60 * 10
  ): Promise<Array<{ id: string; orgId: string }>> {
    const runs = await this.readOnlyPrisma.taskRun.findMany({
      where: {
        id: { in: runIds },
        completedAt: {
          lte: new Date(Date.now() - completedAtOffsetMs), // This only finds runs that were completed more than 10 minutes ago
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

type EnvInputs = {
  envCurrent: number;
  envLimit: number;
  envLimitWithBurst: number;
  burstFactor?: number;
};

function analyzeEnvironment(inputs: EnvInputs) {
  const { envCurrent, envLimit, envLimitWithBurst, burstFactor } = inputs;

  const reasons: string[] = [];
  const envAvailableCapacity = Math.max(0, envLimitWithBurst - envCurrent);
  const canDequeue = envAvailableCapacity > 0;

  if (!canDequeue) {
    reasons.push(
      `Environment concurrency (${envCurrent}) has reached the limit with burst (${envLimitWithBurst}).`
    );
  }

  return {
    canDequeue,
    reasons,
    metrics: {
      envAvailableCapacity,
    },
  };
}

type QueueInputs = {
  paused?: boolean;
  envLimit: number;
  envLimitWithBurst: number;
  queueLimit?: number; // undefined => no explicit queue limit (Lua uses a huge default)
  queueCurrent: number;
  envCurrent: number;
  dueCount?: number; // optional (if you implement countDueMessages)
};

function analyzeQueue(inputs: QueueInputs) {
  const { paused, envLimit, envLimitWithBurst, queueLimit, queueCurrent, envCurrent, dueCount } =
    inputs;

  const reasons: string[] = [];

  // Effective queue limit mirrors the Lua: min(queueLimit || 1_000_000, envLimit)
  const queueLimitCapped = typeof queueLimit === "number" ? queueLimit : 1_000_000;
  const effectiveQueueLimit = Math.min(queueLimitCapped, envLimit);

  const envAvailable = Math.max(0, envLimitWithBurst - envCurrent);
  const queueAvailable = Math.max(0, effectiveQueueLimit - queueCurrent);

  // Mirror Lua's actualMaxCount = min(maxCount, envAvailable, queueAvailable).
  // Here we only need to know if capacity exists at all (maxCount >= 1 assumed).
  const hasCapacity = envAvailable > 0 && queueAvailable > 0;

  // High-signal reasons (ordered)
  if (paused) {
    reasons.push("Queue is paused.");
  }

  if (envAvailable <= 0) {
    reasons.push(
      `Environment concurrency (${envCurrent}) has reached the limit with burst (${envLimitWithBurst}).`
    );
  }

  if (queueAvailable <= 0) {
    reasons.push(
      `Queue concurrency (${queueCurrent}) has reached the effective queue limit (${effectiveQueueLimit}).`
    );
  }

  // Optional visibility: no due messages (score > now or empty queue)
  if (typeof dueCount === "number" && dueCount <= 0) {
    reasons.push("No due messages in the queue (nothing scored ≤ now).");
  }

  // Final decision:
  // - Not paused
  // - Has capacity (both env and queue)
  // - And (optionally) has work due
  const canDequeue = !paused && hasCapacity && (typeof dueCount === "number" ? dueCount > 0 : true);

  return {
    canDequeue,
    reasons: canDequeue ? [] : reasons,
    metrics: {
      effectiveQueueLimit,
      queueAvailableCapacity: queueAvailable,
      messagesDueCount: typeof dueCount === "number" ? dueCount : null,
    },
  };
}
