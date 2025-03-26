import { type RedisOptions } from "@internal/redis";
import { Worker, type WorkerConcurrencyOptions } from "@trigger.dev/redis-worker";
import { Tracer } from "@internal/tracing";
import { MachinePreset, MachinePresetName, QueueOptions, RetryOptions } from "@trigger.dev/core/v3";
import { PrismaClient } from "@trigger.dev/database";
import { FairQueueSelectionStrategyOptions } from "../run-queue/fairQueueSelectionStrategy.js";
import { MinimalAuthenticatedEnvironment } from "../shared/index.js";
import { workerCatalog } from "./workerCatalog.js";

export type RunEngineOptions = {
  prisma: PrismaClient;
  worker: {
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
  queue: {
    redis: RedisOptions;
    retryOptions?: RetryOptions;
    defaultEnvConcurrency?: number;
    queueSelectionStrategyOptions?: Pick<
      FairQueueSelectionStrategyOptions,
      "parentQueueLimit" | "tracer" | "biases" | "reuseSnapshotCount" | "maximumEnvCount"
    >;
  };
  runLock: {
    redis: RedisOptions;
  };
  /** If not set then checkpoints won't ever be used */
  retryWarmStartThresholdMs?: number;
  heartbeatTimeoutsMs?: Partial<HeartbeatTimeouts>;
  queueRunsWaitingForWorkerBatchSize?: number;
  tracer: Tracer;
  releaseConcurrency?: {
    disabled?: boolean;
    maxTokensRatio?: number;
    redis?: Partial<RedisOptions>;
    maxRetries?: number;
    consumersCount?: number;
    pollInterval?: number;
    batchSize?: number;
    backoff?: {
      minDelay?: number; // Defaults to 1000
      maxDelay?: number; // Defaults to 60000
      factor?: number; // Defaults to 2
    };
  };
};

export type HeartbeatTimeouts = {
  PENDING_EXECUTING: number;
  PENDING_CANCEL: number;
  EXECUTING: number;
  EXECUTING_WITH_WAITPOINTS: number;
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
  traceContext: Record<string, string | undefined>;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  lockedToVersionId?: string;
  taskVersion?: string;
  sdkVersion?: string;
  cliVersion?: string;
  concurrencyKey?: string;
  masterQueue?: string;
  queue: string;
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
  releaseConcurrency?: boolean;
};

export type EngineWorker = Worker<typeof workerCatalog>;
