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

  async startAttempt<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { attemptNumber: number; executedAt?: Date; isWarmStart: boolean },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    const prisma = tx ?? this.prisma;

    return prisma.taskRun.update({
      where: { id: runId },
      data: {
        status: "EXECUTING",
        attemptNumber: data.attemptNumber,
        executedAt: data.executedAt,
        isWarmStart: data.isWarmStart,
      },
      select: args.select,
    }) as Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  }

  async completeAttemptSuccess<S extends Prisma.TaskRunSelect>(
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
    const prisma = tx ?? this.prisma;

    return prisma.taskRun.update({
      where: { id: runId },
      data: {
        status: "COMPLETED_SUCCESSFULLY",
        completedAt: data.completedAt,
        output: data.output,
        outputType: data.outputType,
        usageDurationMs: data.usageDurationMs,
        costInCents: data.costInCents,
        executionSnapshots: {
          create: {
            executionStatus: data.snapshot.executionStatus,
            description: data.snapshot.description,
            runStatus: data.snapshot.runStatus,
            attemptNumber: data.snapshot.attemptNumber,
            environmentId: data.snapshot.environmentId,
            environmentType: data.snapshot.environmentType,
            projectId: data.snapshot.projectId,
            organizationId: data.snapshot.organizationId,
            workerId: data.snapshot.workerId,
            runnerId: data.snapshot.runnerId,
          },
        },
      },
      select: args.select,
    }) as Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  }

  async recordRetryOutcome<I extends Prisma.TaskRunInclude>(
    runId: string,
    data: { machinePreset: string; usageDurationMs: number; costInCents: number },
    args: { include: I },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>> {
    const prisma = tx ?? this.prisma;

    return prisma.taskRun.update({
      where: { id: runId },
      data: {
        machinePreset: data.machinePreset,
        usageDurationMs: data.usageDurationMs,
        costInCents: data.costInCents,
      },
      include: args.include,
    }) as Promise<Prisma.TaskRunGetPayload<{ include: I }>>;
  }

  async requeueRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    const prisma = tx ?? this.prisma;

    return prisma.taskRun.update({
      where: { id: runId },
      data: { status: "PENDING" },
      select: args.select,
    }) as Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  }

  async recordBulkActionMembership(
    runId: string,
    bulkActionId: string,
    tx?: PrismaClientOrTransaction
  ): Promise<void> {
    const prisma = tx ?? this.prisma;

    await prisma.taskRun.update({
      where: { id: runId },
      data: {
        bulkActionGroupIds: {
          push: bulkActionId,
        },
      },
    });
  }

  async cancelRun<S extends Prisma.TaskRunSelect>(
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
    const prisma = tx ?? this.prisma;

    return prisma.taskRun.update({
      where: { id: runId },
      data: {
        status: "CANCELED",
        ...(data.completedAt !== undefined && { completedAt: data.completedAt }),
        error: data.error as Prisma.InputJsonValue,
        ...(data.bulkActionId !== undefined && {
          bulkActionGroupIds: { push: data.bulkActionId },
        }),
        ...(data.usageDurationMs !== undefined && { usageDurationMs: data.usageDurationMs }),
        ...(data.costInCents !== undefined && { costInCents: data.costInCents }),
      },
      select: args.select,
    }) as Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  }

  async failRunPermanently<S extends Prisma.TaskRunSelect>(
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
    const prisma = tx ?? this.prisma;

    return prisma.taskRun.update({
      where: { id: runId },
      data: {
        status: data.status,
        completedAt: data.completedAt,
        error: data.error as Prisma.InputJsonValue,
        usageDurationMs: data.usageDurationMs,
        costInCents: data.costInCents,
      },
      select: args.select,
    }) as Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
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
