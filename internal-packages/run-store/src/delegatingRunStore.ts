// A pass-through over another RunStore.
//
// It exists so a decorator can override the handful of methods it cares about and inherit the rest.
//
// Every member restates the interface signature and forwards its arguments BY NAME, so the
// forwarding is itself type-checked: a body that called the wrong delegate method, or dropped an
// argument, does not compile. That is the whole point of the shape. An untyped forwarder would let
// both mistakes through, because a pass-through has no other behaviour to catch them.
//
// Seven members are overloaded. Their overloads are declared so callers keep the full contract, and
// their single implementation signature is the one place a cast appears: TypeScript cannot express
// one body that satisfies an overload set without it.
//
// Keeping this in step with the interface is not a matter of memory. `implements RunStore` rejects a
// member that is missing, and the assertion at the foot of the file rejects one the interface never
// declared.

import type {
  BatchTaskRun,
  BatchTaskRunItemStatus,
  Prisma,
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunStatus,
  WaitpointTag,
} from "@trigger.dev/database";
import type { TaskRunError } from "@trigger.dev/core/v3/schemas";
import type { Residency } from "@trigger.dev/core/v3/isomorphic";
import type {
  ClearIdempotencyKeyInput,
  CompletionSnapshotInput,
  CreateBatchTaskRunData,
  CreateCancelledRunInput,
  CreateExecutionSnapshotInput,
  CreateFailedRunInput,
  CreateRunInput,
  ExpireSnapshotInput,
  FinalizeRunData,
  ForWaitpointCompletionContext,
  IdempotencyKeyRunMatch,
  LockRunData,
  PromotePendingVersionArgs,
  ReadClient,
  RescheduleSnapshotInput,
  RewriteDebouncedRunData,
  RunStore,
  TaskRunWithWaitpoint,
  WaitpointColocationOptions,
} from "./types.js";

export class DelegatingRunStore implements RunStore {
  constructor(protected readonly delegate: RunStore) {}

  runInTransaction<R>(
    runId: string | undefined,
    fn: (store: RunStore, tx: PrismaClientOrTransaction) => Promise<R>
  ): Promise<R> {
    return this.delegate.runInTransaction(runId, fn);
  }

  createRun(params: CreateRunInput, tx?: PrismaClientOrTransaction): Promise<TaskRunWithWaitpoint> {
    return this.delegate.createRun(params, tx);
  }

  createCancelledRun(
    params: CreateCancelledRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    return this.delegate.createCancelledRun(params, tx);
  }

  createFailedRun(
    params: CreateFailedRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint> {
    return this.delegate.createFailedRun(params, tx);
  }

  startAttempt<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { attemptNumber: number; executedAt?: Date; isWarmStart: boolean },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    return this.delegate.startAttempt(runId, data, args, tx);
  }

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
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    return this.delegate.completeAttemptSuccess(runId, data, args, tx);
  }

  recordRetryOutcome<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { machinePreset?: string; usageDurationMs: number; costInCents: number },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    return this.delegate.recordRetryOutcome(runId, data, args, tx);
  }

  requeueRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    return this.delegate.requeueRun(runId, args, tx);
  }

  recordBulkActionMembership(
    runId: string,
    bulkActionId: string,
    tx?: PrismaClientOrTransaction
  ): Promise<void> {
    return this.delegate.recordBulkActionMembership(runId, bulkActionId, tx);
  }

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
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    return this.delegate.cancelRun(runId, data, args, tx);
  }

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
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    return this.delegate.failRunPermanently(runId, data, args, tx);
  }

  finalizeRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: FinalizeRunData,
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  finalizeRun<I extends Prisma.TaskRunInclude>(
    runId: string,
    data: FinalizeRunData,
    args: { include: I },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>>;
  finalizeRun(
    runId: string,
    data: FinalizeRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun>;
  finalizeRun(...args: unknown[]): unknown {
    return (this.delegate.finalizeRun as (...a: unknown[]) => unknown).apply(this.delegate, args);
  }

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
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    return this.delegate.expireRun(runId, data, args, tx);
  }

  expireRunsBatch(
    runIds: string[],
    data: { error: TaskRunError; now: Date },
    tx?: PrismaClientOrTransaction
  ): Promise<number> {
    return this.delegate.expireRunsBatch(runIds, data, tx);
  }

  lockRunToWorker(
    runId: string,
    data: LockRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{}>> {
    return this.delegate.lockRunToWorker(runId, data, tx);
  }

  parkPendingVersion<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { statusReason: string },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    return this.delegate.parkPendingVersion(runId, data, args, tx);
  }

  promotePendingVersionRuns(
    runId: string,
    args?: PromotePendingVersionArgs,
    tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }> {
    return this.delegate.promotePendingVersionRuns(runId, args, tx);
  }

  expireParkedRun(
    runId: string,
    data: {
      error: TaskRunError;
      completedAt: Date;
      expiredAt: Date;
      statusReason: string;
      snapshot: ExpireSnapshotInput;
    },
    tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }> {
    return this.delegate.expireParkedRun(runId, data, tx);
  }

  suspendForCheckpoint<I extends Prisma.TaskRunInclude>(
    runId: string,
    args: { include: I },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>> {
    return this.delegate.suspendForCheckpoint(runId, args, tx);
  }

  resumeFromCheckpoint<S extends Prisma.TaskRunSelect>(
    runId: string,
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    return this.delegate.resumeFromCheckpoint(runId, args, tx);
  }

  rescheduleRun(
    runId: string,
    data: { delayUntil: Date; queueTimestamp?: Date; snapshot?: RescheduleSnapshotInput },
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    return this.delegate.rescheduleRun(runId, data, tx);
  }

  enqueueDelayedRun(
    runId: string,
    data: { queuedAt: Date },
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    return this.delegate.enqueueDelayedRun(runId, data, tx);
  }

  rewriteDebouncedRun(
    runId: string,
    data: RewriteDebouncedRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint> {
    return this.delegate.rewriteDebouncedRun(runId, data, tx);
  }

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
  ): Promise<{ count: number }> {
    return this.delegate.updateMetadata(runId, data, options, tx);
  }

  clearIdempotencyKey(
    params: ClearIdempotencyKeyInput,
    tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }> {
    return this.delegate.clearIdempotencyKey(params, tx);
  }

  pushTags(
    runId: string,
    tags: string[],
    where: { runtimeEnvironmentId: string },
    tx?: PrismaClientOrTransaction
  ): Promise<{ updatedAt: Date }> {
    return this.delegate.pushTags(runId, tags, where, tx);
  }

  pushRealtimeStream(
    runId: string,
    streamId: string,
    tx?: PrismaClientOrTransaction
  ): Promise<void> {
    return this.delegate.pushRealtimeStream(runId, streamId, tx);
  }

  get primaryReadClient(): ReadClient {
    return this.delegate.primaryReadClient;
  }

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
  findRun(...args: unknown[]): unknown {
    return (this.delegate.findRun as (...a: unknown[]) => unknown).apply(this.delegate, args);
  }

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
  findRunOrThrow(...args: unknown[]): unknown {
    return (this.delegate.findRunOrThrow as (...a: unknown[]) => unknown).apply(
      this.delegate,
      args
    );
  }

  findRunOnPrimary<S extends Prisma.TaskRunSelect>(
    where: Prisma.TaskRunWhereInput,
    args: { select: S }
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }> | null>;
  findRunOnPrimary<I extends Prisma.TaskRunInclude>(
    where: Prisma.TaskRunWhereInput,
    args: { include: I }
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }> | null>;
  findRunOnPrimary(where: Prisma.TaskRunWhereInput): Promise<TaskRun | null>;
  findRunOnPrimary(...args: unknown[]): unknown {
    return (this.delegate.findRunOnPrimary as (...a: unknown[]) => unknown).apply(
      this.delegate,
      args
    );
  }

  findRunOrThrowOnPrimary<S extends Prisma.TaskRunSelect>(
    where: Prisma.TaskRunWhereInput,
    args: { select: S }
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  findRunOrThrowOnPrimary<I extends Prisma.TaskRunInclude>(
    where: Prisma.TaskRunWhereInput,
    args: { include: I }
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>>;
  findRunOrThrowOnPrimary(where: Prisma.TaskRunWhereInput): Promise<TaskRun>;
  findRunOrThrowOnPrimary(...args: unknown[]): unknown {
    return (this.delegate.findRunOrThrowOnPrimary as (...a: unknown[]) => unknown).apply(
      this.delegate,
      args
    );
  }

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
  findRuns(...args: unknown[]): unknown {
    return (this.delegate.findRuns as (...a: unknown[]) => unknown).apply(this.delegate, args);
  }

  findRunsByIds<S extends Prisma.TaskRunSelect>(
    ids: string[],
    args: { select: S },
    client?: ReadClient
  ): Promise<Map<string, Prisma.TaskRunGetPayload<{ select: S }>>>;
  findRunsByIds<I extends Prisma.TaskRunInclude>(
    ids: string[],
    args: { include: I },
    client?: ReadClient
  ): Promise<Map<string, Prisma.TaskRunGetPayload<{ include: I }>>>;
  findRunsByIds(ids: string[], client?: ReadClient): Promise<Map<string, TaskRun>>;
  findRunsByIds(...args: unknown[]): unknown {
    return (this.delegate.findRunsByIds as (...a: unknown[]) => unknown).apply(this.delegate, args);
  }

  findRunsByIdempotencyKeys(
    args: { runtimeEnvironmentId: string; taskIdentifier: string; idempotencyKeys: string[] },
    client?: ReadClient
  ): Promise<IdempotencyKeyRunMatch[]> {
    return this.delegate.findRunsByIdempotencyKeys(args, client);
  }

  createBatchTaskRunItem(
    data: { batchTaskRunId: string; taskRunId: string; status: BatchTaskRunItemStatus },
    tx?: PrismaClientOrTransaction
  ): Promise<void> {
    return this.delegate.createBatchTaskRunItem(data, tx);
  }

  findLatestExecutionSnapshot(
    runId: string,
    client?: ReadClient,
    // When set, scopes the read to this environment (tenant boundary); a run in another env reads as
    // not-found. Omit to read regardless of environment (internal callers).
    environmentId?: string
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{
    include: { completedWaitpoints: true; checkpoint: true };
  }> | null> {
    return this.delegate.findLatestExecutionSnapshot(runId, client);
  }

  findExecutionSnapshot<T extends Prisma.TaskRunExecutionSnapshotFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunExecutionSnapshotFindFirstArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T> | null> {
    return this.delegate.findExecutionSnapshot(args, client);
  }

  findManyExecutionSnapshots<T extends Prisma.TaskRunExecutionSnapshotFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunExecutionSnapshotFindManyArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T>[]> {
    return this.delegate.findManyExecutionSnapshots(args, client);
  }

  createExecutionSnapshot(
    input: CreateExecutionSnapshotInput,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{ include: { checkpoint: true } }>> {
    return this.delegate.createExecutionSnapshot(input, tx);
  }

  findSnapshotCompletedWaitpointIds(
    snapshotId: string,
    client?: ReadClient,
    runId?: string
  ): Promise<string[]> {
    return this.delegate.findSnapshotCompletedWaitpointIds(snapshotId, client, runId);
  }

  findSnapshotCompletedWaitpointIdsWithPresence(
    snapshotId: string,
    client?: ReadClient,
    runId?: string
  ): Promise<{ present: boolean; ids: string[] }> {
    return this.delegate.findSnapshotCompletedWaitpointIdsWithPresence(snapshotId, client, runId);
  }

  findWaitpointConnectedRunIds(waitpointId: string, client?: ReadClient): Promise<string[]> {
    return this.delegate.findWaitpointConnectedRunIds(waitpointId, client);
  }

  findWaitpointCompletedSnapshotIds(waitpointId: string, client?: ReadClient): Promise<string[]> {
    return this.delegate.findWaitpointCompletedSnapshotIds(waitpointId, client);
  }

  blockRunWithWaitpointEdges(params: {
    runId: string;
    waitpointIds: string[];
    projectId: string;
    spanIdToComplete?: string;
    batchId?: string;
    batchIndex?: number;
    tx?: PrismaClientOrTransaction;
  }): Promise<void> {
    return this.delegate.blockRunWithWaitpointEdges(params);
  }

  countPendingWaitpoints(
    waitpointIds: string[],
    client?: ReadClient,
    runId?: string
  ): Promise<number> {
    return this.delegate.countPendingWaitpoints(waitpointIds, client, runId);
  }

  countPendingWaitpointsWithPresence(
    waitpointIds: string[],
    client?: ReadClient
  ): Promise<{ pendingIds: string[]; presentIds: string[] }> {
    return this.delegate.countPendingWaitpointsWithPresence(waitpointIds, client);
  }

  createWaitpoint<T extends Prisma.WaitpointCreateArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointCreateArgs>,
    tx?: PrismaClientOrTransaction,
    opts?: WaitpointColocationOptions
  ): Promise<Prisma.WaitpointGetPayload<T>> {
    return this.delegate.createWaitpoint(args, tx, opts);
  }

  upsertWaitpoint<T extends Prisma.WaitpointUpsertArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointUpsertArgs>,
    tx?: PrismaClientOrTransaction,
    opts?: WaitpointColocationOptions
  ): Promise<Prisma.WaitpointGetPayload<T>> {
    return this.delegate.upsertWaitpoint(args, tx, opts);
  }

  findWaitpoint<T extends Prisma.WaitpointFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointFindFirstArgs>,
    client?: ReadClient,
    opts?: WaitpointColocationOptions
  ): Promise<Prisma.WaitpointGetPayload<T> | null> {
    return this.delegate.findWaitpoint(args, client, opts);
  }

  findWaitpointOnPrimary<T extends Prisma.WaitpointFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointFindFirstArgs>
  ): Promise<Prisma.WaitpointGetPayload<T> | null> {
    return this.delegate.findWaitpointOnPrimary(args);
  }

  findManyWaitpoints<T extends Prisma.WaitpointFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointFindManyArgs>,
    client?: ReadClient,
    runId?: string
  ): Promise<Prisma.WaitpointGetPayload<T>[]> {
    return this.delegate.findManyWaitpoints(args, client, runId);
  }

  updateWaitpoint<T extends Prisma.WaitpointUpdateArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointUpdateArgs>,
    tx?: PrismaClientOrTransaction,
    opts?: WaitpointColocationOptions
  ): Promise<Prisma.WaitpointGetPayload<T>> {
    return this.delegate.updateWaitpoint(args, tx, opts);
  }

  updateManyWaitpoints(
    args: Prisma.WaitpointUpdateManyArgs,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchPayload> {
    return this.delegate.updateManyWaitpoints(args, tx);
  }

  forWaitpointCompletion(
    waitpointId: string,
    context: ForWaitpointCompletionContext
  ): Promise<RunStore> {
    return this.delegate.forWaitpointCompletion(waitpointId, context);
  }

  findManyTaskRunWaitpoints<T extends Prisma.TaskRunWaitpointFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunWaitpointFindManyArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunWaitpointGetPayload<T>[]> {
    return this.delegate.findManyTaskRunWaitpoints(args, client);
  }

  deleteManyTaskRunWaitpoints(
    args: Prisma.TaskRunWaitpointDeleteManyArgs,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchPayload> {
    return this.delegate.deleteManyTaskRunWaitpoints(args, tx);
  }

  findTaskRunAttempt<T extends Prisma.TaskRunAttemptFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunAttemptFindFirstArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunAttemptGetPayload<T> | null> {
    return this.delegate.findTaskRunAttempt(args, client);
  }

  createTaskRunCheckpoint<T extends Prisma.TaskRunCheckpointCreateArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunCheckpointCreateArgs>,
    ownerRunId?: string,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunCheckpointGetPayload<T>> {
    return this.delegate.createTaskRunCheckpoint(args, ownerRunId, tx);
  }

  createBatchTaskRun(
    data: CreateBatchTaskRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<BatchTaskRun> {
    return this.delegate.createBatchTaskRun(data, tx);
  }

  updateBatchTaskRun<S extends Prisma.BatchTaskRunSelect>(
    args: {
      where: Prisma.BatchTaskRunWhereUniqueInput;
      data: Prisma.BatchTaskRunUpdateInput;
      select: S;
    },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchTaskRunGetPayload<{ select: S }>> {
    return this.delegate.updateBatchTaskRun(args, tx);
  }

  findBatchTaskRunById<T extends Prisma.BatchTaskRunInclude = {}>(
    id: string,
    args?: { include?: T },
    client?: ReadClient
  ): Promise<Prisma.BatchTaskRunGetPayload<{ include: T }> | null> {
    return this.delegate.findBatchTaskRunById(id, args, client);
  }

  findBatchTaskRunByFriendlyId<T extends Prisma.BatchTaskRunInclude = {}>(
    friendlyId: string,
    environmentId: string,
    args?: { include?: T },
    client?: ReadClient
  ): Promise<Prisma.BatchTaskRunGetPayload<{ include: T }> | null> {
    return this.delegate.findBatchTaskRunByFriendlyId(friendlyId, environmentId, args, client);
  }

  findBatchTaskRunByIdempotencyKey<T extends Prisma.BatchTaskRunInclude = {}>(
    environmentId: string,
    idempotencyKey: string,
    args?: { include?: T },
    client?: ReadClient
  ): Promise<Prisma.BatchTaskRunGetPayload<{ include: T }> | null> {
    return this.delegate.findBatchTaskRunByIdempotencyKey(
      environmentId,
      idempotencyKey,
      args,
      client
    );
  }

  updateManyBatchTaskRun(
    args: Prisma.BatchTaskRunUpdateManyArgs,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchPayload> {
    return this.delegate.updateManyBatchTaskRun(args, tx);
  }

  countBatchTaskRunItems(
    where: { batchTaskRunId: string; status?: BatchTaskRunItemStatus },
    client?: ReadClient
  ): Promise<number> {
    return this.delegate.countBatchTaskRunItems(where, client);
  }

  updateManyBatchTaskRunItems(
    args: Prisma.BatchTaskRunItemUpdateManyArgs,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchPayload> {
    return this.delegate.updateManyBatchTaskRunItems(args, tx);
  }

  findManyBatchTaskRunItems<I extends Prisma.BatchTaskRunItemInclude = {}>(
    where: { taskRunId?: string; batchTaskRunId?: string },
    args?: { include?: I },
    client?: ReadClient
  ): Promise<Prisma.BatchTaskRunItemGetPayload<{ include: I }>[]> {
    return this.delegate.findManyBatchTaskRunItems(where, args, client);
  }

  findBatchTaskRunItem<I extends Prisma.BatchTaskRunItemInclude = {}>(
    where: { batchTaskRunId: string; taskRunId?: string },
    args?: { include?: I },
    client?: ReadClient
  ): Promise<Prisma.BatchTaskRunItemGetPayload<{ include: I }> | null> {
    return this.delegate.findBatchTaskRunItem(where, args, client);
  }

  upsertWaitpointTag(
    data: { environmentId: string; name: string; projectId: string; id?: string },
    tx?: PrismaClientOrTransaction,
    // A tag has no owning run to co-locate with; when no minted `id` pins it by id-shape, a
    // minted-new env's tags read this residency (NEW) so they land with the env's tokens/runs
    // instead of defaulting to LEGACY. Single-store impls ignore it.
    residency?: Residency
  ): Promise<WaitpointTag> {
    return this.delegate.upsertWaitpointTag(data, tx);
  }

  findManyWaitpointTags(
    args: {
      where: Prisma.WaitpointTagWhereInput;
      orderBy?:
        | Prisma.WaitpointTagOrderByWithRelationInput
        | Prisma.WaitpointTagOrderByWithRelationInput[];
      take?: number;
      skip?: number;
    },
    client?: ReadClient
  ): Promise<WaitpointTag[]> {
    return this.delegate.findManyWaitpointTags(args, client);
  }
}

// `implements` above rejects a member of the interface that is missing here. It says nothing about a
// member that should not exist, so the reverse direction is asserted too: a public member this class
// declares and the interface does not is a build failure.
//
// `protected delegate` is correctly absent from `keyof`, so the constructor parameter does not trip
// this.
type _ClassDeclaresNoExtraMembers = [Exclude<keyof DelegatingRunStore, keyof RunStore>] extends [
  never,
]
  ? true
  : never;
const _classParity: _ClassDeclaresNoExtraMembers = true;
void _classParity;
