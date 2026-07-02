import type {
  BatchTaskRun,
  BatchTaskRunItemStatus,
  Prisma,
  PrismaClientOrTransaction,
  PrismaReplicaClient,
  TaskRun,
  TaskRunStatus,
  TaskRunExecutionStatus,
  RuntimeEnvironmentType,
  Waitpoint,
} from "@trigger.dev/database";
import type { TaskRunError } from "@trigger.dev/core/v3/schemas";
import type { Residency } from "@trigger.dev/core/v3/isomorphic";

/**
 * Client accepted by the read methods. Reads route through the replica by
 * default, so callers may pass either the writer/transaction client or the
 * read replica — both expose the `taskRun.findFirst`/`findMany` surface the
 * reads use. Write methods stay on `PrismaClientOrTransaction`.
 */
export type ReadClient = PrismaClientOrTransaction | PrismaReplicaClient;

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
  data: CreateRunData & {
    error: Prisma.InputJsonValue;
    completedAt: Date;
    updatedAt: Date;
    attemptNumber: 0;
  };
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
  | {
      byPredicate: { idempotencyKey: string; taskIdentifier: string; runtimeEnvironmentId: string };
      byId?: never;
      byFriendlyIds?: never;
    }
  | { byFriendlyIds: string[]; byId?: never; byPredicate?: never };

export type TaskRunWithWaitpoint = TaskRun & { associatedWaitpoint: Waitpoint | null };

/**
 * Structured input for {@link RunStore.createExecutionSnapshot}. The store derives the
 * `completedWaitpoints.connect` / `completedWaitpointOrder` / `isValid` fields from this
 * input — callers pass the high-level shape, not a raw Prisma `data`/`include`.
 */
export type CreateExecutionSnapshotInput = {
  run: { id: string; status: TaskRunStatus; attemptNumber?: number | null };
  snapshot: {
    executionStatus: TaskRunExecutionStatus;
    description: string;
    metadata?: Prisma.JsonValue;
  };
  previousSnapshotId?: string;
  batchId?: string;
  environmentId: string;
  environmentType: RuntimeEnvironmentType;
  projectId: string;
  organizationId: string;
  checkpointId?: string;
  workerId?: string;
  runnerId?: string;
  completedWaitpoints?: { id: string; index?: number }[];
  error?: string;
};

// Create payload for `createBatchTaskRun`: scalar `runtimeEnvironmentId` (the FK is
// dropped for cross-DB residency; env existence is validated app-side at create).
export type CreateBatchTaskRunData = Prisma.BatchTaskRunUncheckedCreateInput;

/**
 * Mirror of the webapp's `UnblockRouteKind`. The engine/run-store cannot import the
 * webapp types, so this union is kept IDENTICAL (members + field names) to
 * `apps/webapp/app/v3/runOpsMigration/types.ts` so the two cannot drift conceptually.
 */
export type WaitpointUnblockRouteKind =
  | "MANUAL"
  | "DATETIME"
  | "RESUME_TOKEN"
  | "IDEMPOTENCY_REUSE"
  | "RUN";

/**
 * Pinning context for {@link RunStore.forWaitpointCompletion}. Mirrors the webapp's
 * waitpoint-completion pinning input shape.
 */
export interface ForWaitpointCompletionContext {
  routeKind: WaitpointUnblockRouteKind;
  treeOwnerResidency?: Residency;
  isCrossTreeIdempotency?: boolean;
  hasLegacyParent?: boolean;
}

/**
 * Co-location hint for the waitpoint write/lookup methods. A DATETIME/MANUAL wait waitpoint's
 * minted id is always a cuid, so id-shape routing always sends it to LEGACY; when `coLocateWithRunId`
 * is set the router routes by the OWNING RUN's id instead, landing the waitpoint on the run's DB so
 * the block edge's local `Waitpoint` join resolves. Single-store implementations ignore it.
 */
export interface WaitpointColocationOptions {
  coLocateWithRunId?: string;
}

export interface RunStore {
  /**
   * Run a co-resident multi-write unit atomically on the store that OWNS `runId`. The callback gets
   * the owning `RunStore` plus a `tx` opened on THAT store's OWN client; passing `tx` to the inner
   * writes lands them all in ONE transaction on the owning DB (NEW for a ksuid run, LEGACY for a cuid
   * run), so a failure between two writes rolls BOTH back. NOT a cross-DB transaction: `tx` is the
   * owning store's own client (never the control-plane tx), and every write MUST target the same run /
   * its co-resident subgraph. Callers MUST use the supplied `store` + `tx`, not the outer router
   * (which would re-route and drop the tx). Single-store impls run `fn(this, tx)` in their own
   * `$transaction`.
   */
  runInTransaction<R>(
    runId: string | undefined,
    fn: (store: RunStore, tx: PrismaClientOrTransaction) => Promise<R>
  ): Promise<R>;

  // Create
  createRun(params: CreateRunInput, tx?: PrismaClientOrTransaction): Promise<TaskRunWithWaitpoint>;
  createCancelledRun(
    params: CreateCancelledRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun>;
  createFailedRun(
    params: CreateFailedRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint>;

  // Attempt lifecycle
  startAttempt<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { attemptNumber: number; executedAt?: Date; isWarmStart: boolean },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  completeAttemptSuccess<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: {
      completedAt: Date;
      output?: string;
      outputType: string;
      usageDurationMs: number;
      costInCents: number;
      snapshot: CompletionSnapshotInput;
    },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  recordRetryOutcome<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { machinePreset?: string; usageDurationMs: number; costInCents: number },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  requeueRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  recordBulkActionMembership(
    runId: string,
    bulkActionId: string,
    tx?: PrismaClientOrTransaction
  ): Promise<void>;
  cancelRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: {
      completedAt?: Date;
      error: TaskRunError;
      bulkActionId?: string;
      usageDurationMs?: number;
      costInCents?: number;
    },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  failRunPermanently<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: {
      status: TaskRunStatus;
      completedAt: Date;
      error: TaskRunError;
      usageDurationMs: number;
      costInCents: number;
    },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;

  // Expiry
  expireRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: {
      error: TaskRunError;
      completedAt: Date;
      expiredAt: Date;
      snapshot: ExpireSnapshotInput;
    },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  expireRunsBatch(
    runIds: string[],
    data: { error: TaskRunError; now: Date },
    tx?: PrismaClientOrTransaction
  ): Promise<number>;

  // Dequeue / version / checkpoint
  lockRunToWorker(
    runId: string,
    data: LockRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{}>>;
  parkPendingVersion<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { statusReason: string },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  promotePendingVersionRuns(
    runId: string,
    tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }>;
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
  enqueueDelayedRun(
    runId: string,
    data: { queuedAt: Date },
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun>;
  rewriteDebouncedRun(
    runId: string,
    data: RewriteDebouncedRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint>;

  // Field touches
  updateMetadata(
    runId: string,
    data: {
      metadata: string | null;
      metadataType?: string;
      metadataVersion: { increment: number };
      updatedAt: Date;
    },
    options: { expectedMetadataVersion?: number },
    tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }>;
  clearIdempotencyKey(
    params: ClearIdempotencyKeyInput,
    tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }>;
  pushTags(
    runId: string,
    tags: string[],
    where: { runtimeEnvironmentId: string },
    tx?: PrismaClientOrTransaction
  ): Promise<{ updatedAt: Date }>;
  pushRealtimeStream(
    runId: string,
    streamId: string,
    tx?: PrismaClientOrTransaction
  ): Promise<void>;

  // Read
  findRun<S extends Prisma.TaskRunSelect>(
    where: Prisma.TaskRunWhereInput,
    args: { select: S },
    client?: ReadClient
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }> | null>;
  findRun<I extends Prisma.TaskRunInclude>(
    where: Prisma.TaskRunWhereInput,
    args: { include: I },
    client?: ReadClient
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }> | null>;
  findRun(where: Prisma.TaskRunWhereInput, client?: ReadClient): Promise<TaskRun | null>;

  findRunOrThrow<S extends Prisma.TaskRunSelect>(
    where: Prisma.TaskRunWhereInput,
    args: { select: S },
    client?: ReadClient
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  findRunOrThrow<I extends Prisma.TaskRunInclude>(
    where: Prisma.TaskRunWhereInput,
    args: { include: I },
    client?: ReadClient
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>>;
  findRunOrThrow(where: Prisma.TaskRunWhereInput, client?: ReadClient): Promise<TaskRun>;

  // Read-after-write on the OWNING store's primary (writer), never the replica — for re-reading a
  // run just written in this request, where replica lag would cause a false miss (mirrors
  // findWaitpointOnPrimary). The routing store dispatches here per owning store so each reads its
  // own writer, never leaking a control-plane client into another DB.
  findRunOnPrimary<S extends Prisma.TaskRunSelect>(
    where: Prisma.TaskRunWhereInput,
    args: { select: S }
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }> | null>;
  findRunOnPrimary<I extends Prisma.TaskRunInclude>(
    where: Prisma.TaskRunWhereInput,
    args: { include: I }
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }> | null>;
  findRunOnPrimary(where: Prisma.TaskRunWhereInput): Promise<TaskRun | null>;

  findRunOrThrowOnPrimary<S extends Prisma.TaskRunSelect>(
    where: Prisma.TaskRunWhereInput,
    args: { select: S }
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  findRunOrThrowOnPrimary<I extends Prisma.TaskRunInclude>(
    where: Prisma.TaskRunWhereInput,
    args: { include: I }
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>>;
  findRunOrThrowOnPrimary(where: Prisma.TaskRunWhereInput): Promise<TaskRun>;

  findRuns<S extends Prisma.TaskRunSelect>(
    args: {
      where: Prisma.TaskRunWhereInput;
      select: S;
      orderBy?: Prisma.TaskRunOrderByWithRelationInput | Prisma.TaskRunOrderByWithRelationInput[];
      take?: number;
      skip?: number;
      cursor?: Prisma.TaskRunWhereUniqueInput;
    },
    client?: ReadClient
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
    client?: ReadClient
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>[]>;
  findRuns(
    args: {
      where: Prisma.TaskRunWhereInput;
      orderBy?: Prisma.TaskRunOrderByWithRelationInput | Prisma.TaskRunOrderByWithRelationInput[];
      take?: number;
      skip?: number;
      cursor?: Prisma.TaskRunWhereUniqueInput;
    },
    client?: ReadClient
  ): Promise<TaskRun[]>;

  // --- run-ops persistence ---
  // Snapshots, waitpoints, implicit M:N joins, dependents, attempts and checkpoints. The
  // generic model wrappers are thin generics over the Prisma `*Args` types so include/select
  // payload typing survives at the call site; the snapshot DTO builder and the two raw-SQL
  // waitpoint methods keep their hand-written shapes.

  // Batch membership
  createBatchTaskRunItem(
    data: { batchTaskRunId: string; taskRunId: string; status: BatchTaskRunItemStatus },
    tx?: PrismaClientOrTransaction
  ): Promise<void>;

  // Snapshot group
  findLatestExecutionSnapshot(
    runId: string,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{
    include: { completedWaitpoints: true; checkpoint: true };
  }> | null>;
  findExecutionSnapshot<T extends Prisma.TaskRunExecutionSnapshotFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunExecutionSnapshotFindFirstArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T> | null>;
  findManyExecutionSnapshots<T extends Prisma.TaskRunExecutionSnapshotFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunExecutionSnapshotFindManyArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T>[]>;
  createExecutionSnapshot(
    input: CreateExecutionSnapshotInput,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{ include: { checkpoint: true } }>>;

  // Implicit-join group
  findSnapshotCompletedWaitpointIds(snapshotId: string, client?: ReadClient): Promise<string[]>;
  /** Run ids connected to a waitpoint (WaitpointRunConnection / `_WaitpointRunConnections`), this DB only. */
  findWaitpointConnectedRunIds(waitpointId: string, client?: ReadClient): Promise<string[]>;
  /** Snapshot ids that completed a waitpoint (CompletedWaitpoint / `_completedWaitpoints`), this DB only. */
  findWaitpointCompletedSnapshotIds(waitpointId: string, client?: ReadClient): Promise<string[]>;
  blockRunWithWaitpointEdges(params: {
    runId: string;
    waitpointIds: string[];
    projectId: string;
    spanIdToComplete?: string;
    batchId?: string;
    batchIndex?: number;
    tx?: PrismaClientOrTransaction;
  }): Promise<void>;
  countPendingWaitpoints(waitpointIds: string[], client?: ReadClient): Promise<number>;

  // Waitpoint group
  createWaitpoint<T extends Prisma.WaitpointCreateArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointCreateArgs>,
    tx?: PrismaClientOrTransaction,
    opts?: WaitpointColocationOptions
  ): Promise<Prisma.WaitpointGetPayload<T>>;
  upsertWaitpoint<T extends Prisma.WaitpointUpsertArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointUpsertArgs>,
    tx?: PrismaClientOrTransaction,
    opts?: WaitpointColocationOptions
  ): Promise<Prisma.WaitpointGetPayload<T>>;
  findWaitpoint<T extends Prisma.WaitpointFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointFindFirstArgs>,
    client?: ReadClient,
    opts?: WaitpointColocationOptions
  ): Promise<Prisma.WaitpointGetPayload<T> | null>;
  // Read-after-write on the owning store's primary (never the replica) — for re-reading a
  // waitpoint just written on the unblock path, where replica lag would cause a false miss.
  findWaitpointOnPrimary<T extends Prisma.WaitpointFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointFindFirstArgs>
  ): Promise<Prisma.WaitpointGetPayload<T> | null>;
  findManyWaitpoints<T extends Prisma.WaitpointFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointFindManyArgs>,
    client?: ReadClient
  ): Promise<Prisma.WaitpointGetPayload<T>[]>;
  updateWaitpoint<T extends Prisma.WaitpointUpdateArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointUpdateArgs>,
    tx?: PrismaClientOrTransaction,
    opts?: WaitpointColocationOptions
  ): Promise<Prisma.WaitpointGetPayload<T>>;
  updateManyWaitpoints(
    args: Prisma.WaitpointUpdateManyArgs,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchPayload>;

  /**
   * Select the run-ops store that OWNS a waitpoint completion, by waitpointId
   * residency. completeWaitpoint arrives with only (waitpointId, output) — no run
   * id — so selection is by the waitpoint's own residency, with the documented
   * pins to legacy. Returns the store HANDLE to apply the completion on.
   * Single-store implementations return `this`. Throws UnclassifiableRunId on an
   * ambiguous id in split mode (the engine rethrows it as UnclassifiableWaitpointId).
   */
  forWaitpointCompletion(
    waitpointId: string,
    context: ForWaitpointCompletionContext
  ): Promise<RunStore>;

  // TaskRunWaitpoint group
  findManyTaskRunWaitpoints<T extends Prisma.TaskRunWaitpointFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunWaitpointFindManyArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunWaitpointGetPayload<T>[]>;
  deleteManyTaskRunWaitpoints(
    args: Prisma.TaskRunWaitpointDeleteManyArgs,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchPayload>;

  // Attempt-model group (TaskRunAttempt, V1-residual)
  findTaskRunAttempt<T extends Prisma.TaskRunAttemptFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunAttemptFindFirstArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunAttemptGetPayload<T> | null>;

  // Checkpoint family. `ownerRunId` is the run whose snapshot references this checkpoint via the
  // kept `TaskRunExecutionSnapshot.checkpointId` FK — the routing store co-locates the checkpoint
  // with that run so the snapshot insert can satisfy the FK on the same DB. The checkpoint
  // row itself carries no runId scalar, so the owning run id must be threaded explicitly.
  createTaskRunCheckpoint<T extends Prisma.TaskRunCheckpointCreateArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunCheckpointCreateArgs>,
    ownerRunId?: string,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunCheckpointGetPayload<T>>;

  // --- BatchTaskRun (run-ops) ---
  // Batch row is born on the run-ops store at create. `findBatchTaskRunById`
  // reads the primary by default (worker reads the just-written row; replica lag).
  createBatchTaskRun(
    data: CreateBatchTaskRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<BatchTaskRun>;
  updateBatchTaskRun<S extends Prisma.BatchTaskRunSelect>(
    args: {
      where: Prisma.BatchTaskRunWhereUniqueInput;
      data: Prisma.BatchTaskRunUpdateInput;
      select: S;
    },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchTaskRunGetPayload<{ select: S }>>;
  findBatchTaskRunById<T extends Prisma.BatchTaskRunInclude = {}>(
    id: string,
    args?: { include?: T },
    client?: ReadClient
  ): Promise<Prisma.BatchTaskRunGetPayload<{ include: T }> | null>;
  findBatchTaskRunByFriendlyId<T extends Prisma.BatchTaskRunInclude = {}>(
    friendlyId: string,
    environmentId: string,
    args?: { include?: T },
    client?: ReadClient
  ): Promise<Prisma.BatchTaskRunGetPayload<{ include: T }> | null>;

  // --- BatchTaskRun (run-ops) — batch residency additions ---
  // The idempotency probe is keyed by (environmentId, idempotencyKey) — no classifiable
  // batch id — so the router fans out NEW→LEGACY (mirrors `findBatchTaskRunByFriendlyId`).
  findBatchTaskRunByIdempotencyKey<T extends Prisma.BatchTaskRunInclude = {}>(
    environmentId: string,
    idempotencyKey: string,
    args?: { include?: T },
    client?: ReadClient
  ): Promise<Prisma.BatchTaskRunGetPayload<{ include: T }> | null>;
  // updateMany of batch rows: route by `where.id` when scalar, else fan-out + sum counts.
  updateManyBatchTaskRun(
    args: Prisma.BatchTaskRunUpdateManyArgs,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchPayload>;
  // Count batch items by `batchTaskRunId` (items co-reside with the batch).
  countBatchTaskRunItems(
    where: { batchTaskRunId: string; status?: BatchTaskRunItemStatus },
    client?: ReadClient
  ): Promise<number>;
  // updateMany of batch items: route by `where.id`/`where.batchTaskRunId`, else fan-out + sum.
  updateManyBatchTaskRunItems(
    args: Prisma.BatchTaskRunItemUpdateManyArgs,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchPayload>;
}
