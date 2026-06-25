import { Prisma } from "@trigger.dev/database";
import type {
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
  FindRunTableScope,
  LockRunData,
  ReadClient,
  RescheduleSnapshotInput,
  RewriteDebouncedRunData,
  RunStore,
  TaskRunWithWaitpoint,
} from "./types.js";
import type { TaskRunError } from "@trigger.dev/core/v3/schemas";
import { isKsuidId } from "@trigger.dev/core/v3/isomorphic";

// Extract a plain string equality from a Prisma string filter — a bare string
// or `{ equals: "..." }`. Returns undefined for any other operator shape (in,
// not, contains, etc.), which callers treat as "can't narrow to one table".
function stringEquality(filter: unknown): string | undefined {
  if (typeof filter === "string") {
    return filter;
  }
  if (
    filter !== null &&
    typeof filter === "object" &&
    "equals" in filter &&
    typeof (filter as { equals?: unknown }).equals === "string"
  ) {
    return (filter as { equals: string }).equals;
  }
  return undefined;
}

export type PostgresRunStoreOptions = {
  prisma: PrismaClient;
  readOnlyPrisma: PrismaReplicaClient;
};

/**
 * Typed write layer for the task-run row. A run lives in one of two physical
 * tables chosen by its id format (`runModel`): the legacy `taskRun`, or the
 * `task_run_v2` clone. `task_run_v2` carries the same relation surface as
 * `TaskRun`, so a method's nested Prisma create/include (execution snapshot,
 * associated waitpoint, `runtimeEnvironment`) targets either table unchanged
 * once the delegate comes from `runModel`.
 *
 * Each method is its original single-table Prisma statement with the run
 * delegate routed through `runModel`. Methods write through `tx` when supplied
 * so callers can opt into an existing transaction. Errors (including unique
 * constraint violations) propagate unchanged.
 */
export class PostgresRunStore implements RunStore {
  private readonly prisma: PrismaClient;
  private readonly readOnlyPrisma: PrismaReplicaClient;

  constructor(options: PostgresRunStoreOptions) {
    this.prisma = options.prisma;
    this.readOnlyPrisma = options.readOnlyPrisma;
  }

  /**
   * A run lives in exactly one physical table, chosen by the FORMAT of its id:
   * a KSUID id (new) lives in `task_run_v2`, the legacy cuid id in `TaskRun`.
   * `task_run_v2` is an identical clone of `TaskRun` down to its relations, so
   * its delegate is cast to the `taskRun` delegate type to reuse the existing
   * generic `select`/`include`/nested-write passthrough unchanged.
   */
  private runModel(client: PrismaClientOrTransaction, idOrFriendlyId: string) {
    return isKsuidId(idOrFriendlyId)
      ? (client.taskRunV2 as unknown as typeof client.taskRun)
      : client.taskRun;
  }

  /**
   * The routing key for a single-row read: the `{ id }` or `{ friendlyId }`
   * value in the `where` clause. Both carry the same KSUID/cuid body and route
   * to the same physical table. Returns `undefined` for a predicate that
   * addresses no specific run (e.g. an idempotency-key lookup), which must read
   * both tables rather than assume one.
   */
  #routingKeyOf(where: Prisma.TaskRunWhereInput): string | undefined {
    return typeof where.id === "string"
      ? where.id
      : typeof where.friendlyId === "string"
      ? where.friendlyId
      : undefined;
  }

  /**
   * Read a single row matching a non-id predicate from BOTH physical tables.
   * A key-based predicate (idempotency key, "has this env any runs") can match
   * a row in either table. Query both in parallel and return the match,
   * preferring `task_run_v2` when both are non-null.
   *
   * Today a run lives in exactly one table (createRun routes by id format), so
   * at most one side is non-null and the preference never bites. The later
   * slow legacy->v2 migration copies a run into task_run_v2 before operating on
   * it, so it transiently lives in BOTH tables with the v2 copy as the
   * canonical/operated-on one; preferring v2 returns the current row, not the
   * stale legacy source. `task_run_v2` is an identical clone of `TaskRun`, so
   * the SAME args (select/include and the security-scoping `where`) run
   * unchanged against either delegate.
   */
  async #findFirstAcrossTables(
    prisma: ReadClient,
    where: Prisma.TaskRunWhereInput,
    args: { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude },
    tables: FindRunTableScope = "both"
  ): Promise<unknown> {
    // Legacy-only scope: the caller knows the run can't be in task_run_v2 (e.g.
    // idempotency dedup for an org not cut over to v2), so skip the second,
    // empty v2 query and keep this a single-table read on the hot path.
    if (tables === "legacy") {
      return prisma.taskRun.findFirst({ where, ...args });
    }

    const v2Model = prisma.taskRunV2 as unknown as typeof prisma.taskRun;

    const [legacyRun, v2Run] = await Promise.all([
      prisma.taskRun.findFirst({ where, ...args }),
      v2Model.findFirst({ where, ...args }),
    ]);

    return v2Run ?? legacyRun;
  }

  async createRun(
    params: CreateRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint> {
    const client = tx ?? this.prisma;

    return this.runModel(client, params.data.id).create({
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

    return this.runModel(client, params.data.id).create({
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

    return this.runModel(client, params.data.id).create({
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

    return this.runModel(prisma, runId).update({
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

    return this.runModel(prisma, runId).update({
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
    data: { machinePreset?: string; usageDurationMs: number; costInCents: number },
    args: { include: I },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>> {
    const prisma = tx ?? this.prisma;

    return this.runModel(prisma, runId).update({
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

    return this.runModel(prisma, runId).update({
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

    await this.runModel(prisma, runId).update({
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

    return this.runModel(prisma, runId).update({
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

    return this.runModel(prisma, runId).update({
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

  async expireRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { error: TaskRunError; completedAt: Date; expiredAt: Date; snapshot: ExpireSnapshotInput },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    const prisma = tx ?? this.prisma;

    return this.runModel(prisma, runId).update({
      where: { id: runId },
      data: {
        status: "EXPIRED",
        completedAt: data.completedAt,
        expiredAt: data.expiredAt,
        error: data.error as Prisma.InputJsonValue,
        executionSnapshots: {
          create: {
            engine: data.snapshot.engine,
            executionStatus: data.snapshot.executionStatus,
            description: data.snapshot.description,
            runStatus: data.snapshot.runStatus,
            environmentId: data.snapshot.environmentId,
            environmentType: data.snapshot.environmentType,
            projectId: data.snapshot.projectId,
            organizationId: data.snapshot.organizationId,
          },
        },
      },
      select: args.select,
    }) as Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  }

  async expireRunsBatch(
    runIds: string[],
    data: { error: TaskRunError; now: Date },
    tx?: PrismaClientOrTransaction
  ): Promise<number> {
    const prisma = tx ?? this.prisma;

    // Nothing to do for an empty set, and Prisma.join would build an invalid
    // `IN ()` clause, so short-circuit before touching the database.
    if (runIds.length === 0) {
      return 0;
    }

    // A run lives in exactly one table, chosen by its id format. The array may
    // be mixed, so partition it and run the UPDATE once per non-empty partition
    // on its own table, then sum the counts.
    const v2Ids = runIds.filter((id) => isKsuidId(id));
    const legacyIds = runIds.filter((id) => !isKsuidId(id));

    const error = JSON.stringify(data.error);

    let count = 0;

    if (legacyIds.length > 0) {
      count += await prisma.$executeRaw`
        UPDATE "TaskRun"
        SET "status" = 'EXPIRED'::"TaskRunStatus",
            "completedAt" = ${data.now},
            "expiredAt" = ${data.now},
            "updatedAt" = ${data.now},
            "error" = ${error}::jsonb
        WHERE "id" IN (${Prisma.join(legacyIds)})
      `;
    }

    if (v2Ids.length > 0) {
      count += await prisma.$executeRaw`
        UPDATE "task_run_v2"
        SET "status" = 'EXPIRED'::"TaskRunStatus",
            "completedAt" = ${data.now},
            "expiredAt" = ${data.now},
            "updatedAt" = ${data.now},
            "error" = ${error}::jsonb
        WHERE "id" IN (${Prisma.join(v2Ids)})
      `;
    }

    return count;
  }

  async lockRunToWorker(
    runId: string,
    data: LockRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: { runtimeEnvironment: true } }>> {
    const prisma = tx ?? this.prisma;

    return this.runModel(prisma, runId).update({
      where: { id: runId },
      data: {
        status: "DEQUEUED",
        lockedAt: data.lockedAt,
        lockedById: data.lockedById,
        lockedToVersionId: data.lockedToVersionId,
        lockedQueueId: data.lockedQueueId,
        lockedRetryConfig: data.lockedRetryConfig ?? undefined,
        startedAt: data.startedAt,
        baseCostInCents: data.baseCostInCents,
        machinePreset: data.machinePreset,
        taskVersion: data.taskVersion,
        sdkVersion: data.sdkVersion ?? undefined,
        cliVersion: data.cliVersion ?? undefined,
        maxDurationInSeconds: data.maxDurationInSeconds ?? undefined,
        maxAttempts: data.maxAttempts ?? undefined,
        executionSnapshots: {
          create: {
            id: data.snapshot.id,
            engine: "V2",
            executionStatus: "PENDING_EXECUTING",
            description: "Run was dequeued for execution",
            runStatus: "PENDING",
            attemptNumber: data.snapshot.attemptNumber ?? undefined,
            previousSnapshotId: data.snapshot.previousSnapshotId,
            environmentId: data.snapshot.environmentId,
            environmentType: data.snapshot.environmentType,
            projectId: data.snapshot.projectId,
            organizationId: data.snapshot.organizationId,
            checkpointId: data.snapshot.checkpointId ?? undefined,
            batchId: data.snapshot.batchId ?? undefined,
            completedWaitpoints: {
              connect: data.snapshot.completedWaitpointIds.map((id) => ({ id })),
            },
            completedWaitpointOrder: data.snapshot.completedWaitpointOrder,
            workerId: data.snapshot.workerId ?? undefined,
            runnerId: data.snapshot.runnerId ?? undefined,
          },
        },
      },
      include: {
        runtimeEnvironment: true,
      },
    }) as Promise<Prisma.TaskRunGetPayload<{ include: { runtimeEnvironment: true } }>>;
  }

  async parkPendingVersion<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { statusReason: string },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    const prisma = tx ?? this.prisma;

    return this.runModel(prisma, runId).update({
      where: { id: runId },
      data: {
        status: "PENDING_VERSION",
        statusReason: data.statusReason,
      },
      select: args.select,
    }) as Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  }

  async promotePendingVersionRuns(
    runId: string,
    tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }> {
    const prisma = tx ?? this.prisma;

    const result = await this.runModel(prisma, runId).updateMany({
      where: { id: runId, status: "PENDING_VERSION" },
      data: { status: "PENDING" },
    });

    return { count: result.count };
  }

  async suspendForCheckpoint<I extends Prisma.TaskRunInclude>(
    runId: string,
    args: { include: I },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>> {
    const prisma = tx ?? this.prisma;

    return this.runModel(prisma, runId).update({
      where: { id: runId },
      data: { status: "WAITING_TO_RESUME" },
      include: args.include,
    }) as Promise<Prisma.TaskRunGetPayload<{ include: I }>>;
  }

  async resumeFromCheckpoint<S extends Prisma.TaskRunSelect>(
    runId: string,
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    const prisma = tx ?? this.prisma;

    return this.runModel(prisma, runId).update({
      where: { id: runId },
      data: { status: "EXECUTING" },
      select: args.select,
    }) as Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  }

  async rescheduleRun(
    runId: string,
    data: { delayUntil: Date; queueTimestamp?: Date; snapshot?: RescheduleSnapshotInput },
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    const prisma = tx ?? this.prisma;

    return this.runModel(prisma, runId).update({
      where: { id: runId },
      data: {
        delayUntil: data.delayUntil,
        ...(data.queueTimestamp !== undefined && { queueTimestamp: data.queueTimestamp }),
        ...(data.snapshot && {
          executionSnapshots: {
            create: {
              engine: "V2",
              executionStatus: "DELAYED",
              description: "Delayed run was rescheduled to a future date",
              runStatus: "DELAYED",
              environmentId: data.snapshot.environmentId,
              environmentType: data.snapshot.environmentType,
              projectId: data.snapshot.projectId,
              organizationId: data.snapshot.organizationId,
            },
          },
        }),
      },
    });
  }

  async enqueueDelayedRun(
    runId: string,
    data: { queuedAt: Date },
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    const prisma = tx ?? this.prisma;

    return this.runModel(prisma, runId).update({
      where: { id: runId },
      data: {
        status: "PENDING",
        queuedAt: data.queuedAt,
      },
    });
  }

  async rewriteDebouncedRun(
    runId: string,
    data: RewriteDebouncedRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint> {
    const prisma = tx ?? this.prisma;

    return this.runModel(prisma, runId).update({
      where: { id: runId },
      data,
      include: {
        associatedWaitpoint: true,
      },
    });
  }

  async updateMetadata(
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
    const prisma = tx ?? this.prisma;
    const model = this.runModel(prisma, runId);

    if (options.expectedMetadataVersion !== undefined) {
      const result = await model.updateMany({
        where: { id: runId, metadataVersion: options.expectedMetadataVersion },
        data,
      });
      return { count: result.count };
    }

    await model.update({
      where: { id: runId },
      data,
    });
    return { count: 1 };
  }

  async clearIdempotencyKey(
    params: ClearIdempotencyKeyInput,
    tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }> {
    const prisma = tx ?? this.prisma;

    if (params.byId) {
      const result = await this.runModel(prisma, params.byId.runId).updateMany({
        where: { id: params.byId.runId, idempotencyKey: params.byId.idempotencyKey },
        data: { idempotencyKey: null, idempotencyKeyExpiresAt: null },
      });
      return { count: result.count };
    }

    if (params.byPredicate) {
      // No run id to route by: a matching run could be in either table during
      // the mixed window, so run the predicate against both and sum the counts.
      const where = {
        idempotencyKey: params.byPredicate.idempotencyKey,
        taskIdentifier: params.byPredicate.taskIdentifier,
        runtimeEnvironmentId: params.byPredicate.runtimeEnvironmentId,
      };
      const data = { idempotencyKey: null, idempotencyKeyExpiresAt: null };

      const [legacy, v2] = await Promise.all([
        prisma.taskRun.updateMany({ where, data }),
        (prisma.taskRunV2 as unknown as typeof prisma.taskRun).updateMany({ where, data }),
      ]);

      return { count: legacy.count + v2.count };
    }

    // byFriendlyIds — only clears idempotencyKey, not idempotencyKeyExpiresAt.
    // The friendlyId carries the same KSUID/cuid body as the id, so it routes
    // the same way; partition the (possibly mixed) array and sum the counts.
    const v2FriendlyIds = params.byFriendlyIds.filter((friendlyId) => isKsuidId(friendlyId));
    const legacyFriendlyIds = params.byFriendlyIds.filter((friendlyId) => !isKsuidId(friendlyId));

    let count = 0;

    if (legacyFriendlyIds.length > 0) {
      const result = await prisma.taskRun.updateMany({
        where: { friendlyId: { in: legacyFriendlyIds } },
        data: { idempotencyKey: null },
      });
      count += result.count;
    }

    if (v2FriendlyIds.length > 0) {
      const result = await (prisma.taskRunV2 as unknown as typeof prisma.taskRun).updateMany({
        where: { friendlyId: { in: v2FriendlyIds } },
        data: { idempotencyKey: null },
      });
      count += result.count;
    }

    return { count };
  }

  async pushTags(
    runId: string,
    tags: string[],
    where: { runtimeEnvironmentId: string },
    tx?: PrismaClientOrTransaction
  ): Promise<{ updatedAt: Date }> {
    const prisma = tx ?? this.prisma;

    return this.runModel(prisma, runId).update({
      where: { id: runId, runtimeEnvironmentId: where.runtimeEnvironmentId },
      data: { runTags: { push: tags } },
      select: { updatedAt: true },
    });
  }

  async pushRealtimeStream(
    runId: string,
    streamId: string,
    tx?: PrismaClientOrTransaction
  ): Promise<void> {
    const prisma = tx ?? this.prisma;

    await this.runModel(prisma, runId).update({
      where: { id: runId },
      data: { realtimeStreams: { push: streamId } },
    });
  }

  findRun<S extends Prisma.TaskRunSelect>(
    where: Prisma.TaskRunWhereInput,
    args: { select: S; tables?: FindRunTableScope },
    client?: ReadClient
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }> | null>;
  findRun<I extends Prisma.TaskRunInclude>(
    where: Prisma.TaskRunWhereInput,
    args: { include: I; tables?: FindRunTableScope },
    client?: ReadClient
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }> | null>;
  findRun(
    where: Prisma.TaskRunWhereInput,
    client?: ReadClient
  ): Promise<TaskRun | null>;
  async findRun(
    where: Prisma.TaskRunWhereInput,
    argsOrClient?:
      | { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude; tables?: FindRunTableScope }
      | ReadClient,
    client?: ReadClient
  ): Promise<unknown> {
    const { args, prisma, tables } = this.#resolveReadArgs(argsOrClient, client);

    const routingKey = this.#routingKeyOf(where);
    if (routingKey !== undefined) {
      // by id / friendlyId: the id format picks exactly one table, O(1).
      return this.runModel(prisma, routingKey).findFirst({ where, ...args });
    }

    // Non-id predicate (e.g. idempotency-key dedup): the match can be in
    // either table, so read both (unless the caller scopes to legacy-only).
    return this.#findFirstAcrossTables(prisma, where, args, tables);
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
  findRunOrThrow(
    where: Prisma.TaskRunWhereInput,
    client?: ReadClient
  ): Promise<TaskRun>;
  async findRunOrThrow(
    where: Prisma.TaskRunWhereInput,
    argsOrClient?: { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude } | ReadClient,
    client?: ReadClient
  ): Promise<unknown> {
    const { args, prisma } = this.#resolveReadArgs(argsOrClient, client);

    const routingKey = this.#routingKeyOf(where);
    if (routingKey !== undefined) {
      return this.runModel(prisma, routingKey).findFirstOrThrow({ where, ...args });
    }

    // Non-id predicate: read both tables, then enforce the throw-on-miss
    // contract ourselves (neither table's findFirstOrThrow could see the
    // other's row).
    const run = await this.#findFirstAcrossTables(prisma, where, args);
    if (run === null || run === undefined) {
      throw new Error("PostgresRunStore.findRunOrThrow: no run matched the predicate");
    }
    return run;
  }

  findRuns<S extends Prisma.TaskRunSelect>(
    args: {
      where: Prisma.TaskRunWhereInput;
      select: S;
      orderBy?: Prisma.TaskRunOrderByWithRelationInput | Prisma.TaskRunOrderByWithRelationInput[];
      take?: number;
      skip?: number;
      cursor?: Prisma.TaskRunWhereUniqueInput;
      tables?: FindRunTableScope;
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
      tables?: FindRunTableScope;
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
      tables?: FindRunTableScope;
    },
    client?: ReadClient
  ): Promise<TaskRun[]>;
  async findRuns(
    rawArgs: {
      where: Prisma.TaskRunWhereInput;
      select?: Prisma.TaskRunSelect;
      include?: Prisma.TaskRunInclude;
      orderBy?: Prisma.TaskRunOrderByWithRelationInput | Prisma.TaskRunOrderByWithRelationInput[];
      take?: number;
      skip?: number;
      cursor?: Prisma.TaskRunWhereUniqueInput;
      tables?: FindRunTableScope;
    },
    client?: ReadClient
  ): Promise<unknown> {
    const prisma = client ?? this.readOnlyPrisma;

    // Split the table-scope hint out of the args that get spread into Prisma
    // (which would reject an unknown `tables` field) before anything reads them.
    const { tables: tableScope = "both", ...args } = rawArgs;

    // A run lives in exactly one physical table, chosen by its id format. An
    // `id: { in: [...] }` predicate of a single id format addresses ONE table;
    // any other predicate may span both `TaskRun` (legacy cuid) and
    // `task_run_v2` (new ksuid). `task_run_v2` is an identical clone of
    // `TaskRun` (same relation surface), so the SAME `args` (crucially the SAME
    // `where`, the security scope) run unchanged against either delegate.
    const legacyModel = prisma.taskRun;
    const v2Model = prisma.taskRunV2 as unknown as typeof prisma.taskRun;

    const tablesForWhere = this.#tablesForWhere(args.where);
    const queryLegacy = tablesForWhere.queryLegacy;
    // A "legacy" scope hint (the caller knows no run can be in task_run_v2 — e.g.
    // no v2 run exists anywhere because native realtime is off) skips the empty v2
    // query, the same hot-path optimisation findRun uses. It is meant for non-id
    // predicates (parentTaskRunId, idempotencyKey); pairing it with a KSUID-only
    // id predicate forces both tables off and returns [] (correct: a v2 id can't
    // match a legacy-only read), but id reads already route by format, so the
    // hint is redundant there rather than passed by real callers.
    const queryV2 = tableScope === "legacy" ? false : tablesForWhere.queryV2;

    // No candidate table (e.g. an empty `id: { in: [] }`) → matches nothing.
    if (!queryLegacy && !queryV2) {
      return [];
    }

    // Exactly one physical table is in play. There's no cross-table merge, so
    // delegate to that table's `findMany` with the args verbatim: Postgres
    // orders natively (ordering by any column, incl. `id`, is a valid total
    // order WITHIN one table) and `skip`/`cursor`/`take` are all
    // single-table-valid. Only the both-table path below needs the in-memory
    // comparator/merge and its keyset restrictions.
    if (queryLegacy !== queryV2) {
      const model = queryLegacy ? legacyModel : v2Model;
      return model.findMany(args as Prisma.TaskRunFindManyArgs);
    }

    // BOTH tables in play.
    //
    // FORWARD-LOOKING (slow legacy->v2 migration, a later stage): that migration
    // copies a run into task_run_v2 before operating on it, so a run can briefly
    // live in BOTH tables. When that lands, the cross-table reads below (both the
    // ordered #mergeOrdered path AND the unordered concat) must DEDUP BY id,
    // keeping the canonical v2 copy, or a doubly-present run is returned twice.
    // Dedup needs `id` forced into the projection (and stripped when the caller
    // didn't select it), and the "v2 wins" policy is part of the copy protocol,
    // so it belongs with the migration PR that introduces the overlap. Today
    // createRun routes by id format, so no run is in both tables and concatenation
    // is already duplicate-free.
    //
    // Offset pagination can't be expressed across two tables (applying `skip` to
    // each skips N rows from its own result, not N from the merged result), so
    // reject it rather than silently double-skip.
    if (args.skip !== undefined) {
      throw new Error(
        "RunStore.findRuns: `skip` (offset pagination) is not supported across the legacy TaskRun " +
          "and task_run_v2 tables. Use a where-based keyset (createdAt + id) instead."
      );
    }

    const ordered = this.#normalizeOrderBy(args.orderBy);

    // Both tables are queried here (single-table reads were delegated earlier).
    // A Prisma `cursor` addresses one row in one table, and a negative `take`
    // (Prisma "last N") is meaningless across a 2-way merge — neither can span
    // both tables. No caller pairs either with a cross-table read; reject
    // loudly rather than silently returning a wrong or empty result. Keyset
    // callers carry their cursor in `where`, which both per-table queries honor.
    if (args.cursor !== undefined) {
      throw new Error(
        "RunStore.findRuns: a Prisma `cursor` cannot span both run tables. " +
          "Use a where-based keyset (e.g. `where: { createdAt: { lt: X } }`) instead."
      );
    }
    if (typeof args.take === "number" && args.take < 0) {
      throw new Error(
        "RunStore.findRuns: a negative `take` (Prisma 'last N') is not supported across both run tables."
      );
    }
    // `take` without `orderBy` across BOTH tables is non-deterministic: each
    // table is capped at `take` independently, then the two capped sets are
    // concatenated, so once one table fills `take` the other table's rows are
    // silently dropped. Reject it (like `skip`/`cursor` above) rather than
    // return a result that may omit one table. Add an `orderBy` for a bounded
    // cross-table merge, or scope the predicate to a single table.
    if (args.take !== undefined && ordered.length === 0) {
      throw new Error(
        "RunStore.findRuns: `take` without `orderBy` is not supported across both run tables " +
          "(each table is capped independently, so the cap is non-deterministic and may omit one " +
          "table's rows). Add an `orderBy` for a bounded cross-table merge, or scope the predicate " +
          "to a single table."
      );
    }

    // ORDERED + LIMITED → bounded 2-way merge.
    if (ordered.length > 0 && args.take !== undefined) {
      const comparator = this.#buildCrossTableComparator(ordered);

      // The in-memory comparator reads the order keys off each row, so they
      // MUST be in the projection. If the caller's `select` omits one, add it
      // for the query and strip it from the output. (`include`/full-row already
      // carry every scalar.)
      const { args: queryArgs, addedKeys } = this.#withOrderKeysSelected(args, ordered);

      // Take at most `take` from each table: the merged head of two ordered
      // streams of length `take` is fully determined by their first `take` rows.
      const perTableArgs = { ...queryArgs, take: args.take };

      const [legacyRows, v2Rows] = (await Promise.all([
        queryLegacy ? legacyModel.findMany(perTableArgs) : Promise.resolve([]),
        queryV2 ? v2Model.findMany(perTableArgs) : Promise.resolve([]),
      ])) as [Array<Record<string, unknown>>, Array<Record<string, unknown>>];

      const merged = this.#mergeOrdered(legacyRows, v2Rows, comparator, args.take);
      return this.#stripAddedKeys(merged, addedKeys);
    }

    // UNORDERED / NO-LIMIT → run the SAME args against both tables and
    // concatenate. A run is in exactly one table, so concatenation is complete
    // and has no duplicates. (`take` without `orderBy` was rejected above;
    // `orderBy` + `take` took the bounded-merge branch above.)
    //
    // `orderBy` without `take` still needs the order keys projected so the
    // whole-set re-sort below can read them.
    const { args: queryArgs, addedKeys } =
      ordered.length > 0
        ? this.#withOrderKeysSelected(args, ordered)
        : { args, addedKeys: [] as string[] };

    const [legacyRows, v2Rows] = (await Promise.all([
      queryLegacy ? legacyModel.findMany(queryArgs) : Promise.resolve([]),
      queryV2 ? v2Model.findMany(queryArgs) : Promise.resolve([]),
    ])) as [Array<Record<string, unknown>>, Array<Record<string, unknown>>];

    let combined = legacyRows.concat(v2Rows);

    // `orderBy` without `take`: each table came back ordered, but the
    // concatenation is not — re-sort the whole bounded set to honor the order.
    if (ordered.length > 0) {
      const comparator = this.#buildCrossTableComparator(ordered);
      combined = combined.sort(comparator);
    }

    return this.#stripAddedKeys(combined, addedKeys);
  }

  /**
   * Which physical tables a `findRuns` predicate can match. A run id encodes
   * its table, so an `id: { in: [...] }` list containing only cuids cannot match
   * `task_run_v2` (and a ksuid-only list cannot match `TaskRun`): the table with
   * no candidate ids is skipped, avoiding a wasted query against an empty
   * `task_run_v2` during rollout. An empty `in` list matches nothing, so both
   * are skipped. Any other predicate must consult both tables.
   */
  #tablesForWhere(where: Prisma.TaskRunWhereInput): { queryLegacy: boolean; queryV2: boolean } {
    const idFilter = where.id;
    const idIn =
      idFilter !== null && typeof idFilter === "object" && "in" in idFilter
        ? (idFilter as { in?: unknown }).in
        : undefined;

    if (Array.isArray(idIn)) {
      let queryLegacy = false;
      let queryV2 = false;
      for (const id of idIn) {
        if (typeof id === "string" && isKsuidId(id)) {
          queryV2 = true;
        } else {
          queryLegacy = true;
        }
        if (queryLegacy && queryV2) break;
      }
      return { queryLegacy, queryV2 };
    }

    // Plain id equality (string or `{ equals: string }`) also pins the table:
    // a single id encodes its format, so route to the matching table and skip
    // the other (which can't contain it). Mirrors the `id: { in }` partition.
    const idEquals = stringEquality(idFilter);
    if (idEquals !== undefined) {
      return isKsuidId(idEquals)
        ? { queryLegacy: false, queryV2: true }
        : { queryLegacy: true, queryV2: false };
    }

    // friendlyId equality (`run_<id>`) likewise pins the table by id format.
    const friendlyEquals = stringEquality(where.friendlyId);
    if (friendlyEquals !== undefined) {
      const rawId = friendlyEquals.startsWith("run_")
        ? friendlyEquals.slice("run_".length)
        : friendlyEquals;
      return isKsuidId(rawId)
        ? { queryLegacy: false, queryV2: true }
        : { queryLegacy: true, queryV2: false };
    }

    return { queryLegacy: true, queryV2: true };
  }

  /**
   * The cross-table merge/sort compares order-key VALUES read off each returned
   * row, so every scalar order key must be present in the projection. When the
   * caller passes a `select` that omits an order key, add it (so the row carries
   * the value) and record which keys were added so they can be stripped from the
   * final output — the caller asked not to see them. A query with `include`, or
   * with neither `select` nor `include` (full row), already returns every scalar
   * column, so nothing is added.
   */
  #withOrderKeysSelected(
    args: {
      where: Prisma.TaskRunWhereInput;
      select?: Prisma.TaskRunSelect;
      include?: Prisma.TaskRunInclude;
      orderBy?: Prisma.TaskRunOrderByWithRelationInput | Prisma.TaskRunOrderByWithRelationInput[];
      take?: number;
      skip?: number;
      cursor?: Prisma.TaskRunWhereUniqueInput;
    },
    ordered: Array<{ key: string; direction: "asc" | "desc" }>
  ): {
    args: typeof args;
    addedKeys: string[];
  } {
    // The merge always tiebreaks on `id`, so it must be readable too.
    const requiredKeys = new Set<string>([...ordered.map((entry) => entry.key), "id"]);

    if (!args.select) {
      // include / full-row: all scalars are present already.
      return { args, addedKeys: [] };
    }

    const select = args.select as Record<string, unknown>;
    const addedKeys: string[] = [];
    const augmentedSelect: Record<string, unknown> = { ...select };

    for (const key of requiredKeys) {
      if (!(key in augmentedSelect)) {
        augmentedSelect[key] = true;
        addedKeys.push(key);
      }
    }

    if (addedKeys.length === 0) {
      return { args, addedKeys: [] };
    }

    return { args: { ...args, select: augmentedSelect as Prisma.TaskRunSelect }, addedKeys };
  }

  /** Remove the order-key columns that were added purely to drive the merge. */
  #stripAddedKeys(
    rows: Array<Record<string, unknown>>,
    addedKeys: string[]
  ): Array<Record<string, unknown>> {
    if (addedKeys.length === 0) {
      return rows;
    }

    for (const row of rows) {
      for (const key of addedKeys) {
        delete row[key];
      }
    }

    return rows;
  }

  /**
   * Normalize the optional `orderBy` (single object or array) into an array of
   * single-key order entries, preserving precedence. An empty array means "no
   * ordering requested".
   */
  #normalizeOrderBy(
    orderBy:
      | Prisma.TaskRunOrderByWithRelationInput
      | Prisma.TaskRunOrderByWithRelationInput[]
      | undefined
  ): Array<{ key: string; direction: "asc" | "desc" }> {
    if (orderBy === undefined) {
      return [];
    }

    const list = Array.isArray(orderBy) ? orderBy : [orderBy];
    const entries: Array<{ key: string; direction: "asc" | "desc" }> = [];

    for (const clause of list) {
      for (const [key, value] of Object.entries(clause)) {
        // Only scalar `{ field: "asc" | "desc" }` entries are mergeable in
        // memory. A relation/nested sort (value is an object) can't be compared
        // here — flag it rather than mis-order across the two tables.
        if (value === "asc" || value === "desc") {
          entries.push({ key, direction: value });
        } else {
          throw new Error(
            `RunStore.findRuns: cannot merge across tables on a non-scalar orderBy key "${key}". ` +
              "Ordered+limited cross-table reads must order by a scalar column (a time/createdAt field, with id as a tiebreak)."
          );
        }
      }
    }

    return entries;
  }

  /**
   * Build a total-order comparator from the requested scalar order keys.
   *
   * The cross-table merge is only correct when the order is a TOTAL order over
   * the union of both tables. A time-based column (`createdAt`, or any other
   * Date column) provides that; `id` alone does NOT — a cuid and a ksuid live
   * in different, non-interleaving id spaces, so ordering the union by `id`
   * lexicographically is meaningless. Require a time/createdAt key to lead (or
   * appear in) the order, and use `id` only as a within-timestamp tiebreak.
   */
  #buildCrossTableComparator(
    ordered: Array<{ key: string; direction: "asc" | "desc" }>
  ): (a: Record<string, unknown>, b: Record<string, unknown>) => number {
    const hasTimeKey = ordered.some((entry) => this.#isTimeOrderKey(entry.key));

    if (!hasTimeKey) {
      const keys = ordered.map((entry) => entry.key).join(", ");
      throw new Error(
        `RunStore.findRuns: ordered+limited read orders by [${keys}], which is not a valid total order across the ` +
          "legacy TaskRun (cuid) and task_run_v2 (ksuid) tables. Order by a time/createdAt column (id may follow as a tiebreak)."
      );
    }

    // Ensure `id` is present as a final tiebreak so the merge is deterministic
    // when two rows share the leading timestamp. Use the direction of the
    // leading order key for the tiebreak.
    const comparators = [...ordered];
    if (!comparators.some((entry) => entry.key === "id")) {
      comparators.push({ key: "id", direction: ordered[0].direction });
    }

    return (a, b) => {
      for (const { key, direction } of comparators) {
        const cmp = this.#compareValues(a[key], b[key]);
        if (cmp !== 0) {
          return direction === "asc" ? cmp : -cmp;
        }
      }
      return 0;
    };
  }

  /**
   * A column is a valid cross-table total-order lead when it is time-based.
   * `createdAt` is the canonical one; the other Date columns the callers use
   * (`updatedAt`, `completedAt`, etc.) qualify too. The selected/included row
   * must carry the column for the comparator to read it.
   */
  #isTimeOrderKey(key: string): boolean {
    return (
      key === "createdAt" ||
      key === "updatedAt" ||
      key === "completedAt" ||
      key === "startedAt" ||
      key === "queuedAt" ||
      key === "lockedAt" ||
      key === "delayUntil" ||
      key === "expiredAt"
    );
  }

  /** Ascending comparison of two scalar order values (Date, number, string). */
  #compareValues(a: unknown, b: unknown): number {
    if (a === b) return 0;
    // Nulls sort last (Prisma's default for `nulls: "last"` is the common case;
    // a stable, deterministic placement is what matters for the merge).
    if (a === null || a === undefined) return 1;
    if (b === null || b === undefined) return -1;

    if (a instanceof Date && b instanceof Date) {
      return a.getTime() - b.getTime();
    }
    if (typeof a === "number" && typeof b === "number") {
      return a - b;
    }
    // String (id) order MUST match Postgres's collation: this comparator merges
    // the two per-table streams IN MEMORY, but the keyset continuation
    // (`id > cursor`) that fetches the next page is evaluated BY Postgres. If
    // the two disagree, a tied-createdAt boundary that straddles BOTH tables can
    // silently skip or duplicate a row. The run-table id columns inherit the
    // database collation, which on Trigger.dev Cloud (and the default Postgres
    // locale on most systems) is en_US.utf8 — whose ordering of the id charset
    // [0-9A-Za-z] matches `localeCompare("en-US")` (verified exhaustively over
    // every base62 2-gram) but NOT raw code-unit order (e.g. "c" < "Z" under
    // en_US, yet "Z" < "c" by code unit).
    //
    // CAVEAT (self-hosters): this hard-codes the en_US assumption. A database
    // with a different collation ("C"/"POSIX" byte order, or another locale) can
    // disagree with localeCompare("en-US") and skip/duplicate a run at the
    // narrow tied-createdAt cross-table boundary. The collation-independent fix
    // is to force `COLLATE "C"` on the id in BOTH the per-table keyset ORDER BY
    // and this comparator (byte order on both sides); deferred because it needs
    // the keyset expressed as raw SQL rather than a Prisma `orderBy`.
    return String(a).localeCompare(String(b), "en-US");
  }

  /**
   * 2-way merge of two already-ordered streams into the first `take` rows of
   * their combined order. Bounded: walks at most `take` steps. The two inputs
   * are each `findMany`-ordered by the SAME order keys, so a single linear pass
   * picking the smaller head under `comparator` yields the globally-correct head.
   */
  #mergeOrdered(
    left: Array<Record<string, unknown>>,
    right: Array<Record<string, unknown>>,
    comparator: (a: Record<string, unknown>, b: Record<string, unknown>) => number,
    take: number
  ): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    let i = 0;
    let j = 0;

    while (out.length < take && (i < left.length || j < right.length)) {
      if (i >= left.length) {
        out.push(right[j++]);
      } else if (j >= right.length) {
        out.push(left[i++]);
      } else if (comparator(left[i], right[j]) <= 0) {
        out.push(left[i++]);
      } else {
        out.push(right[j++]);
      }
    }

    return out;
  }

  /**
   * The single-row read methods (`findRun`, `findRunOrThrow`) accept either
   * `(where, { select | include }, client?)` or the full-row `(where, client?)`.
   * Disambiguate the second positional arg: a `{ select }` / `{ include }`
   * projection object vs. a Prisma client. A projection object always carries a
   * `select` or `include` key; a Prisma client never does. Anything else (e.g.
   * `undefined`) is treated as "no projection, no explicit client".
   */
  #resolveReadArgs(
    argsOrClient:
      | { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude; tables?: FindRunTableScope }
      | ReadClient
      | undefined,
    client: ReadClient | undefined
  ): {
    args: { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude };
    prisma: ReadClient;
    tables: FindRunTableScope;
  } {
    const isProjection =
      typeof argsOrClient === "object" &&
      argsOrClient !== null &&
      ("select" in argsOrClient || "include" in argsOrClient || "tables" in argsOrClient);

    if (isProjection) {
      // Split the table-scope hint out of the args that get spread into Prisma
      // (which would reject an unknown `tables` field).
      const { tables, ...prismaArgs } = argsOrClient as {
        select?: Prisma.TaskRunSelect;
        include?: Prisma.TaskRunInclude;
        tables?: FindRunTableScope;
      };
      return {
        args: prismaArgs,
        prisma: client ?? this.readOnlyPrisma,
        tables: tables ?? "both",
      };
    }

    // No projection: the second positional arg, when present, is the client.
    return {
      args: {},
      prisma: (argsOrClient as ReadClient | undefined) ?? this.readOnlyPrisma,
      tables: "both",
    };
  }
}
