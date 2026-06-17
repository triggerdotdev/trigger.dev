import type {
  Prisma,
  PrismaClient,
  PrismaClientOrTransaction,
  PrismaReplicaClient,
  TaskRun,
  TaskRunStatus,
} from "@trigger.dev/database";
import type {
  ClearIdempotencyKeyInput,
  CompletionSnapshotInput,
  CreateCancelledRunInput,
  CreateFailedRunInput,
  CreateRunInput,
  ExpireSnapshotInput,
  LockRunData,
  RescheduleSnapshotInput,
  RewriteDebouncedRunData,
  RunStore,
  TaskRunWithWaitpoint,
} from "./types.js";
import type { TaskRunError } from "@trigger.dev/core/v3/schemas";

export type PostgresRunStoreOptions = {
  prisma: PrismaClient;
  readOnlyPrisma: PrismaReplicaClient;
};

/**
 * Typed write layer for the task-run row, backed by the `taskRun` Prisma model.
 *
 * Each method is a verbatim relocation of the Prisma statement that lives at a
 * specific call site today. Methods write through `(tx ?? this.prisma).taskRun`
 * so callers can opt into an existing transaction. Errors (including unique
 * constraint violations) propagate to the caller unchanged.
 */
export class PostgresRunStore implements RunStore {
  private readonly prisma: PrismaClient;
  private readonly readOnlyPrisma: PrismaReplicaClient;

  constructor(options: PostgresRunStoreOptions) {
    this.prisma = options.prisma;
    this.readOnlyPrisma = options.readOnlyPrisma;
  }

  async createRun(
    params: CreateRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint> {
    const client = tx ?? this.prisma;

    return client.taskRun.create({
      include: {
        associatedWaitpoint: true,
      },
      data: {
        ...params.data,
        executionSnapshots: {
          create: {
            engine: params.snapshot.engine,
            executionStatus: params.snapshot.executionStatus,
            description: params.snapshot.description,
            runStatus: params.snapshot.runStatus,
            environmentId: params.snapshot.environmentId,
            environmentType: params.snapshot.environmentType,
            projectId: params.snapshot.projectId,
            organizationId: params.snapshot.organizationId,
            workerId: params.snapshot.workerId,
            runnerId: params.snapshot.runnerId,
          },
        },
        associatedWaitpoint: params.associatedWaitpoint
          ? {
              create: params.associatedWaitpoint,
            }
          : undefined,
      },
    });
  }

  async createCancelledRun(
    params: CreateCancelledRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    const client = tx ?? this.prisma;

    return client.taskRun.create({
      data: {
        ...params.data,
        executionSnapshots: {
          create: {
            engine: params.snapshot.engine,
            executionStatus: params.snapshot.executionStatus,
            description: params.snapshot.description,
            runStatus: params.snapshot.runStatus,
            environmentId: params.snapshot.environmentId,
            environmentType: params.snapshot.environmentType,
            projectId: params.snapshot.projectId,
            organizationId: params.snapshot.organizationId,
            workerId: params.snapshot.workerId,
            runnerId: params.snapshot.runnerId,
          },
        },
      },
    });
  }

  async createFailedRun(
    params: CreateFailedRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint> {
    const client = tx ?? this.prisma;

    return client.taskRun.create({
      include: {
        associatedWaitpoint: true,
      },
      data: {
        ...params.data,
        associatedWaitpoint: params.associatedWaitpoint
          ? {
              create: params.associatedWaitpoint,
            }
          : undefined,
      },
    });
  }

  startAttempt<S extends Prisma.TaskRunSelect>(
    _runId: string,
    _data: { attemptNumber: number; executedAt?: Date; isWarmStart: boolean },
    _args: { select: S },
    _tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    throw new Error("not implemented");
  }

  completeAttemptSuccess<S extends Prisma.TaskRunSelect>(
    _runId: string,
    _data: {
      completedAt: Date;
      output?: string;
      outputType: string;
      usageDurationMs: number;
      costInCents: number;
      snapshot: CompletionSnapshotInput;
    },
    _args: { select: S },
    _tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    throw new Error("not implemented");
  }

  recordRetryOutcome<I extends Prisma.TaskRunInclude>(
    _runId: string,
    _data: { machinePreset: string; usageDurationMs: number; costInCents: number },
    _args: { include: I },
    _tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>> {
    throw new Error("not implemented");
  }

  requeueRun<S extends Prisma.TaskRunSelect>(
    _runId: string,
    _args: { select: S },
    _tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    throw new Error("not implemented");
  }

  recordBulkActionMembership(
    _runId: string,
    _bulkActionId: string,
    _tx?: PrismaClientOrTransaction
  ): Promise<void> {
    throw new Error("not implemented");
  }

  cancelRun<S extends Prisma.TaskRunSelect>(
    _runId: string,
    _data: {
      completedAt?: Date;
      error: TaskRunError;
      bulkActionId?: string;
      usageDurationMs?: number;
      costInCents?: number;
    },
    _args: { select: S },
    _tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    throw new Error("not implemented");
  }

  failRunPermanently<S extends Prisma.TaskRunSelect>(
    _runId: string,
    _data: {
      status: TaskRunStatus;
      completedAt: Date;
      error: TaskRunError;
      usageDurationMs: number;
      costInCents: number;
    },
    _args: { select: S },
    _tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    throw new Error("not implemented");
  }

  expireRun<S extends Prisma.TaskRunSelect>(
    _runId: string,
    _data: { error: TaskRunError; completedAt: Date; expiredAt: Date; snapshot: ExpireSnapshotInput },
    _args: { select: S },
    _tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    throw new Error("not implemented");
  }

  expireRunsBatch(
    _runIds: string[],
    _data: { error: TaskRunError; now: Date },
    _tx?: PrismaClientOrTransaction
  ): Promise<number> {
    throw new Error("not implemented");
  }

  lockRunToWorker(
    _runId: string,
    _data: LockRunData,
    _tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: { runtimeEnvironment: true } }>> {
    throw new Error("not implemented");
  }

  parkPendingVersion<S extends Prisma.TaskRunSelect>(
    _runId: string,
    _data: { statusReason: string },
    _args: { select: S },
    _tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    throw new Error("not implemented");
  }

  promotePendingVersionRuns(
    _runId: string,
    _tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }> {
    throw new Error("not implemented");
  }

  suspendForCheckpoint<I extends Prisma.TaskRunInclude>(
    _runId: string,
    _args: { include: I },
    _tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>> {
    throw new Error("not implemented");
  }

  resumeFromCheckpoint<S extends Prisma.TaskRunSelect>(
    _runId: string,
    _args: { select: S },
    _tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    throw new Error("not implemented");
  }

  rescheduleRun(
    _runId: string,
    _data: { delayUntil: Date; queueTimestamp?: Date; snapshot?: RescheduleSnapshotInput },
    _tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    throw new Error("not implemented");
  }

  enqueueDelayedRun(
    _runId: string,
    _data: { queuedAt: Date },
    _tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    throw new Error("not implemented");
  }

  rewriteDebouncedRun(
    _runId: string,
    _data: RewriteDebouncedRunData,
    _tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint> {
    throw new Error("not implemented");
  }

  updateMetadata(
    _runId: string,
    _data: {
      metadata: string | null;
      metadataType?: string;
      metadataVersion: { increment: number };
      updatedAt: Date;
    },
    _options: { expectedMetadataVersion?: number },
    _tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }> {
    throw new Error("not implemented");
  }

  clearIdempotencyKey(
    _params: ClearIdempotencyKeyInput,
    _tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }> {
    throw new Error("not implemented");
  }

  pushTags(
    _runId: string,
    _tags: string[],
    _where: { runtimeEnvironmentId: string },
    _tx?: PrismaClientOrTransaction
  ): Promise<{ updatedAt: Date }> {
    throw new Error("not implemented");
  }

  pushRealtimeStream(
    _runId: string,
    _streamId: string,
    _tx?: PrismaClientOrTransaction
  ): Promise<void> {
    throw new Error("not implemented");
  }
}
