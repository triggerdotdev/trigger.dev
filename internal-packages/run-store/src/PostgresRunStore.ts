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
  LockRunData,
  RescheduleSnapshotInput,
  RewriteDebouncedRunData,
  RunStore,
  TaskRunWithWaitpoint,
} from "./types.js";
import type { TaskRunError } from "@trigger.dev/core/v3/schemas";
import { isKsuidId } from "@trigger.dev/core/v3/isomorphic";

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
   * Route a single-row read to its physical table from the routing key in the
   * `where` clause. `findRun`/`findRunOrThrow` are always called with a
   * `{ id }` or `{ friendlyId }` predicate; both carry the same KSUID/cuid body
   * and route identically. When neither is a plain string (e.g. an unexpected
   * predicate-only read), default to the legacy `taskRun` table — matching the
   * pre-split single-table behavior.
   */
  #runReadModel(
    prisma: PrismaClientOrTransaction | PrismaReplicaClient,
    where: Prisma.TaskRunWhereInput
  ) {
    const routingKey =
      typeof where.id === "string"
        ? where.id
        : typeof where.friendlyId === "string"
        ? where.friendlyId
        : undefined;

    return routingKey !== undefined && isKsuidId(routingKey)
      ? (prisma.taskRunV2 as unknown as typeof prisma.taskRun)
      : prisma.taskRun;
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
    args: { select: S },
    client?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }> | null>;
  findRun<I extends Prisma.TaskRunInclude>(
    where: Prisma.TaskRunWhereInput,
    args: { include: I },
    client?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }> | null>;
  findRun(
    where: Prisma.TaskRunWhereInput,
    client?: PrismaClientOrTransaction
  ): Promise<TaskRun | null>;
  async findRun(
    where: Prisma.TaskRunWhereInput,
    argsOrClient?: { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude } | PrismaClientOrTransaction,
    client?: PrismaClientOrTransaction
  ): Promise<unknown> {
    const { args, prisma } = this.#resolveReadArgs(argsOrClient, client);

    return this.#runReadModel(prisma, where).findFirst({
      where,
      ...args,
    });
  }

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
  findRunOrThrow(
    where: Prisma.TaskRunWhereInput,
    client?: PrismaClientOrTransaction
  ): Promise<TaskRun>;
  async findRunOrThrow(
    where: Prisma.TaskRunWhereInput,
    argsOrClient?: { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude } | PrismaClientOrTransaction,
    client?: PrismaClientOrTransaction
  ): Promise<unknown> {
    const { args, prisma } = this.#resolveReadArgs(argsOrClient, client);

    return this.#runReadModel(prisma, where).findFirstOrThrow({
      where,
      ...args,
    });
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
  findRuns(
    args: {
      where: Prisma.TaskRunWhereInput;
      orderBy?: Prisma.TaskRunOrderByWithRelationInput | Prisma.TaskRunOrderByWithRelationInput[];
      take?: number;
      skip?: number;
      cursor?: Prisma.TaskRunWhereUniqueInput;
    },
    client?: PrismaClientOrTransaction
  ): Promise<TaskRun[]>;
  async findRuns(
    args: {
      where: Prisma.TaskRunWhereInput;
      select?: Prisma.TaskRunSelect;
      include?: Prisma.TaskRunInclude;
      orderBy?: Prisma.TaskRunOrderByWithRelationInput | Prisma.TaskRunOrderByWithRelationInput[];
      take?: number;
      skip?: number;
      cursor?: Prisma.TaskRunWhereUniqueInput;
    },
    client?: PrismaClientOrTransaction
  ): Promise<unknown> {
    const prisma = client ?? this.readOnlyPrisma;

    return prisma.taskRun.findMany(args);
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
      | { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude }
      | PrismaClientOrTransaction
      | undefined,
    client: PrismaClientOrTransaction | undefined
  ): {
    args: { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude };
    prisma: PrismaClientOrTransaction | PrismaReplicaClient;
  } {
    const isProjection =
      typeof argsOrClient === "object" &&
      argsOrClient !== null &&
      ("select" in argsOrClient || "include" in argsOrClient);

    if (isProjection) {
      return {
        args: argsOrClient as { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude },
        prisma: client ?? this.readOnlyPrisma,
      };
    }

    // No projection: the second positional arg, when present, is the client.
    return {
      args: {},
      prisma: (argsOrClient as PrismaClientOrTransaction | undefined) ?? this.readOnlyPrisma,
    };
  }
}
