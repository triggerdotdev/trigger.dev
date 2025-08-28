import { type RedisOptions } from "@internal/redis";
import { Meter, Tracer } from "@internal/tracing";
import { Logger, LogLevel } from "@trigger.dev/core/logger";
import {
  MachinePreset,
  MachinePresetName,
  RetryOptions,
  TriggerTraceContext,
} from "@trigger.dev/core/v3";
import { PrismaClient, PrismaReplicaClient } from "@trigger.dev/database";
import { Worker, type WorkerConcurrencyOptions } from "@trigger.dev/redis-worker";
import { FairQueueSelectionStrategyOptions } from "../run-queue/fairQueueSelectionStrategy.js";
import { MinimalAuthenticatedEnvironment } from "../shared/index.js";
import { LockRetryConfig } from "./locking.js";
import { workerCatalog } from "./workerCatalog.js";
import { type BillingPlan } from "./billingCache.js";

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
  /** If not set then checkpoints won't ever be used */
  retryWarmStartThresholdMs?: number;
  heartbeatTimeoutsMs?: Partial<HeartbeatTimeouts>;
  suspendedHeartbeatRetriesConfig?: {
    maxCount?: number;
    maxDelayMs?: number;
    initialDelayMs?: number;
    factor?: number;
  };
  queueRunsWaitingForWorkerBatchSize?: number;
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
  friendlyId: string;
  number: number;
  environment: MinimalAuthenticatedEnvironment;
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
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
};

export type EngineWorker = Worker<typeof workerCatalog>;
