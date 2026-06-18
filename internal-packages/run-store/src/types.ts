import type {
  Prisma,
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunStatus,
  TaskRunExecutionStatus,
  RuntimeEnvironmentType,
  Waitpoint,
} from "@trigger.dev/database";
import type { TaskRunError } from "@trigger.dev/core/v3/schemas";

export type CreateRunSnapshotInput = {
  engine: "V2";
  executionStatus: TaskRunExecutionStatus;
  description: string;
  runStatus: TaskRunStatus;
  environmentId: string;
  environmentType: RuntimeEnvironmentType;
  projectId: string;
  organizationId: string;
  workerId?: string;
  runnerId?: string;
};

export type CompletionSnapshotInput = {
  executionStatus: "FINISHED";
  description: string;
  runStatus: TaskRunStatus;
  attemptNumber: number | null;
  environmentId: string;
  environmentType: RuntimeEnvironmentType;
  projectId: string;
  organizationId: string;
  workerId?: string;
  runnerId?: string;
};

export type ExpireSnapshotInput = {
  engine: "V2";
  executionStatus: "FINISHED";
  description: string;
  runStatus: TaskRunStatus;
  environmentId: string;
  environmentType: RuntimeEnvironmentType;
  projectId: string;
  organizationId: string;
};

export type RescheduleSnapshotInput = {
  environmentId: string;
  environmentType: RuntimeEnvironmentType;
  projectId: string;
  organizationId: string;
};

export type LockSnapshotInput = {
  id: string;
  previousSnapshotId: string;
  attemptNumber?: number;
  environmentId: string;
  environmentType: RuntimeEnvironmentType;
  projectId: string;
  organizationId: string;
  checkpointId?: string;
  batchId?: string;
  completedWaitpointIds: string[];
  completedWaitpointOrder: string[];
  workerId?: string;
  runnerId?: string;
};

export type RunAssociatedWaitpointInput = {
  id: string;
  friendlyId: string;
  type: "RUN";
  status: "PENDING";
  idempotencyKey: string;
  userProvidedIdempotencyKey: boolean;
  projectId: string;
  environmentId: string;
};

// The ~60 trigger columns (the existing Prisma create `data` minus the nested relation creates).
export type CreateRunData = {
  id: string;
  engine: "V2";
  status: TaskRunStatus;
  friendlyId: string;
  runtimeEnvironmentId: string;
  environmentType: RuntimeEnvironmentType;
  organizationId: string;
  projectId: string;
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
  idempotencyKeyOptions?: Prisma.InputJsonValue;
  taskIdentifier: string;
  payload: string;
  payloadType: string;
  context?: Prisma.InputJsonValue;
  traceContext: Prisma.InputJsonValue;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  lockedToVersionId?: string;
  taskVersion?: string;
  sdkVersion?: string;
  cliVersion?: string;
  concurrencyKey?: string;
  queue: string;
  lockedQueueId?: string;
  workerQueue?: string;
  region?: string | null;
  isTest: boolean;
  delayUntil?: Date;
  queuedAt?: Date;
  maxAttempts?: number;
  taskEventStore?: string;
  priorityMs?: number;
  queueTimestamp?: Date;
  ttl?: string;
  runTags?: string[];
  oneTimeUseToken?: string;
  parentTaskRunId?: string;
  rootTaskRunId?: string;
  replayedFromTaskRunFriendlyId?: string;
  batchId?: string;
  resumeParentOnCompletion?: boolean;
  depth?: number;
  metadata?: string;
  metadataType?: string;
  seedMetadata?: string;
  seedMetadataType?: string;
  maxDurationInSeconds?: number;
  machinePreset?: string;
  scheduleId?: string;
  scheduleInstanceId?: string;
  createdAt?: Date;
  bulkActionGroupIds?: string[];
  planType?: string;
  realtimeStreamsVersion?: string;
  streamBasinName?: string | null;
  debounce?: Prisma.InputJsonValue;
  annotations?: Prisma.InputJsonValue;
};

export type CreateRunInput = {
  data: CreateRunData;
  snapshot: CreateRunSnapshotInput;
  associatedWaitpoint?: RunAssociatedWaitpointInput;
};

export type CreateCancelledRunInput = {
  data: CreateRunData & { error: Prisma.InputJsonValue; completedAt: Date; updatedAt: Date; attemptNumber: 0 };
  snapshot: CreateRunSnapshotInput;
};

export type CreateFailedRunData = {
  id: string;
  engine: "V2";
  status: "SYSTEM_FAILURE";
  friendlyId: string;
  runtimeEnvironmentId: string;
  environmentType: RuntimeEnvironmentType;
  organizationId: string;
  projectId: string;
  taskIdentifier: string;
  payload: string;
  payloadType: string;
  context: Prisma.InputJsonValue;
  traceContext: Prisma.InputJsonValue;
  traceId: string;
  spanId: string;
  queue: string;
  lockedQueueId?: string;
  isTest: false;
  completedAt: Date;
  error: Prisma.InputJsonObject;
  parentTaskRunId?: string;
  rootTaskRunId?: string;
  depth: number;
  batchId?: string;
  resumeParentOnCompletion?: boolean;
  taskEventStore?: string;
};

export type CreateFailedRunInput = {
  data: CreateFailedRunData;
  associatedWaitpoint?: RunAssociatedWaitpointInput;
};

export type LockRunData = {
  lockedAt: Date;
  lockedById: string;
  lockedToVersionId: string;
  lockedQueueId: string;
  lockedRetryConfig?: Prisma.InputJsonValue;
  startedAt: Date;
  baseCostInCents: number;
  machinePreset: string;
  taskVersion: string;
  sdkVersion: string | null;
  cliVersion: string | null;
  maxDurationInSeconds: number | null | undefined;
  maxAttempts?: number;
  snapshot: LockSnapshotInput;
};

export type RewriteDebouncedRunData = {
  payload: string;
  payloadType: string;
  metadata?: string;
  metadataType?: string;
  maxAttempts?: number;
  maxDurationInSeconds?: number;
  machinePreset?: string;
  runTags?: string[];
};

export type ClearIdempotencyKeyInput =
  | { byId: { runId: string; idempotencyKey: string }; byPredicate?: never; byFriendlyIds?: never }
  | { byPredicate: { idempotencyKey: string; taskIdentifier: string; runtimeEnvironmentId: string }; byId?: never; byFriendlyIds?: never }
  | { byFriendlyIds: string[]; byId?: never; byPredicate?: never };

export type TaskRunWithWaitpoint = TaskRun & { associatedWaitpoint: Waitpoint | null };

export interface RunStore {
  // Create
  createRun(params: CreateRunInput, tx?: PrismaClientOrTransaction): Promise<TaskRunWithWaitpoint>;
  createCancelledRun(params: CreateCancelledRunInput, tx?: PrismaClientOrTransaction): Promise<TaskRun>;
  createFailedRun(params: CreateFailedRunInput, tx?: PrismaClientOrTransaction): Promise<TaskRunWithWaitpoint>;

  // Attempt lifecycle
  startAttempt<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { attemptNumber: number; executedAt?: Date; isWarmStart: boolean },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  completeAttemptSuccess<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { completedAt: Date; output?: string; outputType: string; usageDurationMs: number; costInCents: number; snapshot: CompletionSnapshotInput },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  recordRetryOutcome<I extends Prisma.TaskRunInclude>(
    runId: string,
    data: { machinePreset?: string; usageDurationMs: number; costInCents: number },
    args: { include: I },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>>;
  requeueRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  recordBulkActionMembership(runId: string, bulkActionId: string, tx?: PrismaClientOrTransaction): Promise<void>;
  cancelRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { completedAt?: Date; error: TaskRunError; bulkActionId?: string; usageDurationMs?: number; costInCents?: number },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  failRunPermanently<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { status: TaskRunStatus; completedAt: Date; error: TaskRunError; usageDurationMs: number; costInCents: number },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;

  // Expiry
  expireRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { error: TaskRunError; completedAt: Date; expiredAt: Date; snapshot: ExpireSnapshotInput },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  expireRunsBatch(runIds: string[], data: { error: TaskRunError; now: Date }, tx?: PrismaClientOrTransaction): Promise<number>;

  // Dequeue / version / checkpoint
  lockRunToWorker(
    runId: string,
    data: LockRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: { runtimeEnvironment: true } }>>;
  parkPendingVersion<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { statusReason: string },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  promotePendingVersionRuns(runId: string, tx?: PrismaClientOrTransaction): Promise<{ count: number }>;
  suspendForCheckpoint<I extends Prisma.TaskRunInclude>(
    runId: string,
    args: { include: I },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>>;
  resumeFromCheckpoint<S extends Prisma.TaskRunSelect>(
    runId: string,
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;

  // Delayed / debounce
  rescheduleRun(
    runId: string,
    data: { delayUntil: Date; queueTimestamp?: Date; snapshot?: RescheduleSnapshotInput },
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun>;
  enqueueDelayedRun(runId: string, data: { queuedAt: Date }, tx?: PrismaClientOrTransaction): Promise<TaskRun>;
  rewriteDebouncedRun(runId: string, data: RewriteDebouncedRunData, tx?: PrismaClientOrTransaction): Promise<TaskRunWithWaitpoint>;

  // Field touches
  updateMetadata(
    runId: string,
    data: { metadata: string | null; metadataType?: string; metadataVersion: { increment: number }; updatedAt: Date },
    options: { expectedMetadataVersion?: number },
    tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }>;
  clearIdempotencyKey(params: ClearIdempotencyKeyInput, tx?: PrismaClientOrTransaction): Promise<{ count: number }>;
  pushTags(runId: string, tags: string[], where: { runtimeEnvironmentId: string }, tx?: PrismaClientOrTransaction): Promise<{ updatedAt: Date }>;
  pushRealtimeStream(runId: string, streamId: string, tx?: PrismaClientOrTransaction): Promise<void>;

  // Read
  findRun<S extends Prisma.TaskRunSelect>(
    where: Prisma.TaskRunWhereInput,
    args: { select: S },
    client?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }> | null>;
  findRun<I extends Prisma.TaskRunInclude>(
    where: Prisma.TaskRunWhereInput,
    args: { include: I },
    client?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }> | null>;

  findRunOrThrow<S extends Prisma.TaskRunSelect>(
    where: Prisma.TaskRunWhereInput,
    args: { select: S },
    client?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  findRunOrThrow<I extends Prisma.TaskRunInclude>(
    where: Prisma.TaskRunWhereInput,
    args: { include: I },
    client?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>>;

  findRuns<S extends Prisma.TaskRunSelect>(
    args: {
      where: Prisma.TaskRunWhereInput;
      select: S;
      orderBy?: Prisma.TaskRunOrderByWithRelationInput | Prisma.TaskRunOrderByWithRelationInput[];
      take?: number;
      skip?: number;
      cursor?: Prisma.TaskRunWhereUniqueInput;
    },
    client?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>[]>;
  findRuns<I extends Prisma.TaskRunInclude>(
    args: {
      where: Prisma.TaskRunWhereInput;
      include: I;
      orderBy?: Prisma.TaskRunOrderByWithRelationInput | Prisma.TaskRunOrderByWithRelationInput[];
      take?: number;
      skip?: number;
      cursor?: Prisma.TaskRunWhereUniqueInput;
    },
    client?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>[]>;
}
