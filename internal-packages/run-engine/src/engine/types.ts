import { type WorkerConcurrencyOptions } from "@internal/redis-worker";
import { Tracer } from "@opentelemetry/api";
import { MachinePreset, MachinePresetName, QueueOptions, RetryOptions } from "@trigger.dev/core/v3";
import { PrismaClient } from "@trigger.dev/database";
import { type RedisOptions } from "ioredis";
import { MinimalAuthenticatedEnvironment } from "../shared";

export type RunEngineOptions = {
  redis: RedisOptions;
  prisma: PrismaClient;
  worker: WorkerConcurrencyOptions & {
    pollIntervalMs?: number;
  };
  machines: {
    defaultMachine: MachinePresetName;
    machines: Record<string, MachinePreset>;
    baseCostInCents: number;
  };
  queue?: {
    retryOptions?: RetryOptions;
  };
  /** If not set then checkpoints won't ever be used */
  retryWarmStartThresholdMs?: number;
  heartbeatTimeoutsMs?: Partial<HeartbeatTimeouts>;
  queueRunsWaitingForWorkerBatchSize?: number;
  tracer: Tracer;
};

export type HeartbeatTimeouts = {
  PENDING_EXECUTING: number;
  PENDING_CANCEL: number;
  EXECUTING: number;
  EXECUTING_WITH_WAITPOINTS: number;
};

export type MachineResources = {
  cpu: number;
  memory: number;
};

export type TriggerParams = {
  friendlyId: string;
  number: number;
  environment: MinimalAuthenticatedEnvironment;
  idempotencyKey?: string;
  taskIdentifier: string;
  payload: string;
  payloadType: string;
  context: any;
  traceContext: Record<string, string | undefined>;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  lockedToVersionId?: string;
  concurrencyKey?: string;
  masterQueue: string;
  queueName: string;
  queue?: QueueOptions;
  isTest: boolean;
  delayUntil?: Date;
  queuedAt?: Date;
  maxAttempts?: number;
  priorityMs?: number;
  ttl?: string;
  tags: string[];
  parentTaskRunId?: string;
  rootTaskRunId?: string;
  batchId?: string;
  resumeParentOnCompletion?: boolean;
  depth?: number;
  metadata?: string;
  metadataType?: string;
  seedMetadata?: string;
  seedMetadataType?: string;
};