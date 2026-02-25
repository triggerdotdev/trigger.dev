import { type RedisOptions } from "@internal/redis";
import { Meter, Tracer } from "@internal/tracing";
import { Logger, LogLevel } from "@trigger.dev/core/logger";
import {
  MachinePreset,
  MachinePresetName,
  RetryOptions,
  TriggerTraceContext,
} from "@trigger.dev/core/v3";
import { PrismaClient, PrismaReplicaClient, TaskRun, Waitpoint } from "@trigger.dev/database";
import {
  Worker,
  type WorkerConcurrencyOptions,
  type GlobalRateLimiter,
} from "@trigger.dev/redis-worker";
import { FairQueueSelectionStrategyOptions } from "../run-queue/fairQueueSelectionStrategy.js";
import { MinimalAuthenticatedEnvironment } from "../shared/index.js";
import { LockRetryConfig } from "./locking.js";
import { workerCatalog } from "./workerCatalog.js";
import { type BillingPlan } from "./billingCache.js";
import type { DRRConfig } from "../batch-queue/types.js";

export type RunEngineOptions = {
  prisma: PrismaClient;
  readOnlyPrisma?: PrismaReplicaClient;
  worker: {
    disabled?: boolean;
    redis: RedisOptions;
    pollIntervalMs?: number;
    immediatePollIntervalMs?: number;
    shutdownTimeoutMs?: number;
  } & WorkerConcurrencyOptions;
  machines: {
    defaultMachine: MachinePresetName;
    machines: Record<string, MachinePreset>;
    baseCostInCents: number;
  };
  billing?: {
    getCurrentPlan: (orgId: string) => Promise<BillingPlan>;
  };
  queue: {
    redis: RedisOptions;
    shardCount?: number;
    masterQueueConsumersDisabled?: boolean;
    processWorkerQueueDebounceMs?: number;
    masterQueueConsumersIntervalMs?: number;
    masterQueueCooloffPeriodMs?: number;
    masterQueueCooloffCountThreshold?: number;
    masterQueueConsumerDequeueCount?: number;
    workerOptions?: WorkerConcurrencyOptions;
    retryOptions?: RetryOptions;
    defaultEnvConcurrency?: number;
    defaultEnvConcurrencyBurstFactor?: number;
    logLevel?: LogLevel;
    queueSelectionStrategyOptions?: Pick<
      FairQueueSelectionStrategyOptions,
      "parentQueueLimit" | "tracer" | "biases" | "reuseSnapshotCount" | "maximumEnvCount"
    >;
    dequeueBlockingTimeoutSeconds?: number;
    concurrencySweeper?: {
      scanSchedule?: string;
      processMarkedSchedule?: string;
      scanJitterInMs?: number;
      processMarkedJitterInMs?: number;
    };
    /** TTL system options for automatic run expiration */
    ttlSystem?: {
      /** Number of shards for TTL sorted sets (default: same as queue shards) */
      shardCount?: number;
      /** How often to poll each shard for expired runs (ms, default: 1000) */
      pollIntervalMs?: number;
      /** Max number of runs to expire per poll per shard (default: 100) */
      batchSize?: number;
      /** Whether the entire TTL system is disabled (default: false) */
      disabled?: boolean;
      /** Whether TTL consumers + worker are disabled on this instance (default: false).
       *  When true, ZADD on enqueue still happens but polling loops and the TTL worker don't run. */
      consumersDisabled?: boolean;
      /** Visibility timeout for TTL worker jobs (ms, default: 120000) */
      visibilityTimeoutMs?: number;
      /** Concurrency limit for the TTL redis-worker (default: 1) */
      workerConcurrency?: number;
      /** Max items to accumulate before flushing a batch (default: 500) */
      batchMaxSize?: number;
      /** Max time (ms) to wait for more items before flushing a batch (default: 5000) */
      batchMaxWaitMs?: number;
    };
  };
  runLock: {
    redis: RedisOptions;
    duration?: number;
    automaticExtensionThreshold?: number;
    retryConfig?: LockRetryConfig;
  };
  cache?: {
    redis: RedisOptions;
  };
  batchQueue?: {
    redis: RedisOptions;
    drr?: Partial<DRRConfig>;
    /** Number of master queue shards (default: 1) */
    shardCount?: number;
    /** Worker queue blocking timeout in seconds (enables two-stage processing) */
    workerQueueBlockingTimeoutSeconds?: number;
    consumerEnabled?: boolean;
    consumerCount?: number;
    consumerIntervalMs?: number;
    /** Default processing concurrency per environment when no specific limit is set */
    defaultConcurrency?: number;
    /** Optional global rate limiter to limit processing across all consumers */
    globalRateLimiter?: GlobalRateLimiter;
    /** Retry configuration for failed batch items */
    retry?: {
      /** Maximum number of attempts (including the first). Default: 1 (no retries) */
      maxAttempts: number;
      /** Base delay in milliseconds. Default: 1000 */
      minTimeoutInMs?: number;
      /** Maximum delay in milliseconds. Default: 30000 */
      maxTimeoutInMs?: number;
      /** Exponential backoff factor. Default: 2 */
      factor?: number;
      /** Whether to add jitter to retry delays. Default: true */
      randomize?: boolean;
    };
  };
  debounce?: {
    redis?: RedisOptions;
    /** Maximum duration in milliseconds that a run can be debounced. Default: 1 hour */
    maxDebounceDurationMs?: number;
  };
  /** If not set then checkpoints won't ever be used */
  retryWarmStartThresholdMs?: number;
  heartbeatTimeoutsMs?: Partial<HeartbeatTimeouts>;
  repairSnapshotTimeoutMs?: number;
  treatProductionExecutionStallsAsOOM?: boolean;
  suspendedHeartbeatRetriesConfig?: {
    maxCount?: number;
    maxDelayMs?: number;
    initialDelayMs?: number;
    factor?: number;
  };
  queueRunsWaitingForWorkerBatchSize?: number;
  /** Optional maximum TTL for all runs (e.g. "14d"). If set, runs without an explicit TTL
   *  will use this as their TTL, and runs with a TTL larger than this will be clamped. */
  defaultMaxTtl?: string;
  tracer: Tracer;
  meter?: Meter;
  logger?: Logger;
  logLevel?: LogLevel;
};

export type HeartbeatTimeouts = {
  PENDING_EXECUTING: number;
  PENDING_CANCEL: number;
  EXECUTING: number;
  EXECUTING_WITH_WAITPOINTS: number;
  SUSPENDED: number;
};

export type TriggerParams = {
  number?: number;
  friendlyId: string;
  environment: MinimalAuthenticatedEnvironment;
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
  /** The original user-provided idempotency key and scope */
  idempotencyKeyOptions?: { key: string; scope: "run" | "attempt" | "global" };
  taskIdentifier: string;
  payload: string;
  payloadType: string;
  context: any;
  traceContext: TriggerTraceContext;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  lockedToVersionId?: string;
  taskVersion?: string;
  sdkVersion?: string;
  cliVersion?: string;
  concurrencyKey?: string;
  workerQueue?: string;
  queue: string;
  lockedQueueId?: string;
  isTest: boolean;
  delayUntil?: Date;
  queuedAt?: Date;
  maxAttempts?: number;
  taskEventStore?: string;
  priorityMs?: number;
  queueTimestamp?: Date;
  ttl?: string;
  tags: { id: string; name: string }[];
  parentTaskRunId?: string;
  rootTaskRunId?: string;
  replayedFromTaskRunFriendlyId?: string;
  batch?: {
    id: string;
    index: number;
  };
  resumeParentOnCompletion?: boolean;
  depth?: number;
  metadata?: string;
  metadataType?: string;
  seedMetadata?: string;
  seedMetadataType?: string;
  oneTimeUseToken?: string;
  maxDurationInSeconds?: number;
  machine?: MachinePresetName;
  workerId?: string;
  runnerId?: string;
  scheduleId?: string;
  scheduleInstanceId?: string;
  createdAt?: Date;
  bulkActionId?: string;
  planType?: string;
  realtimeStreamsVersion?: string;
  debounce?: {
    key: string;
    delay: string;
    mode?: "leading" | "trailing";
    maxDelay?: string;
  };
  /**
   * Called when a run is debounced (existing delayed run found with triggerAndWait).
   * Return spanIdToComplete to enable span closing when the run completes.
   * This allows the webapp to create a trace span for the debounced trigger.
   */
  onDebounced?: (params: {
    existingRun: TaskRun;
    waitpoint: Waitpoint;
    debounceKey: string;
  }) => Promise<string | undefined>;
};

export type EngineWorker = Worker<typeof workerCatalog>;

export type ReportableQueue = {
  name: string;
  concurrencyLimit: number | null;
  type: string;
  paused: boolean;
  friendlyId: string;
};
