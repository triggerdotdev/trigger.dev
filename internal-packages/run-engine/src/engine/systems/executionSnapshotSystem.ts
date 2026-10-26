import type { CompletedWaitpoint, ExecutionResult, RunExecutionData } from "@trigger.dev/core/v3";
import { BatchId, RunId, SnapshotId } from "@trigger.dev/core/v3/isomorphic";
import type {
  Prisma,
  PrismaClientOrTransaction,
  RuntimeEnvironmentType,
  TaskRunCheckpoint,
  TaskRunExecutionSnapshot,
  TaskRunExecutionStatus,
  TaskRunStatus,
  Waitpoint,
} from "@trigger.dev/database";
import type {
  CompletedWaitpointRecord,
  LatestExecutionSnapshotRead,
  RunStore,
  SnapshotReadWaitpoint,
  SnapshotReadContext,
  SnapshotRouteWire,
} from "@internal/run-store";
import {
  SnapshotReadUnavailableError,
  SnapshotStateExpiredError,
  snapshotRouteFromSnapshot,
} from "@internal/run-store";
import {
  ExecutionSnapshotNotFoundError,
  LatestExecutionSnapshotNotFoundError,
  ServiceValidationError,
} from "../errors.js";
import { isFinalRunStatus } from "../statuses.js";
import type { HeartbeatTimeouts } from "../types.js";
import type { SystemResources } from "./systems.js";

import { boundedIn } from "@trigger.dev/database";
/** Waitpoint outputs can be 100KB+, so a large fetch can exceed the NAPI string limit. */
const WAITPOINT_CHUNK_SIZE = 100;

export type ExecutionSnapshotSystemOptions = {
  resources: SystemResources;
  heartbeatTimeouts: HeartbeatTimeouts;
};

export interface EnhancedExecutionSnapshot extends TaskRunExecutionSnapshot {
  friendlyId: string;
  runFriendlyId: string;
  checkpoint: TaskRunCheckpoint | null;
  completedWaitpoints: CompletedWaitpoint[];
}

type ExecutionSnapshotWithCheckpoint = Prisma.TaskRunExecutionSnapshotGetPayload<{
  include: {
    checkpoint: true;
  };
}>;

function enhanceExecutionSnapshot(
  snapshot: LatestExecutionSnapshotRead
): EnhancedExecutionSnapshot {
  return enhanceExecutionSnapshotWithWaitpoints(
    snapshot,
    snapshot.completedWaitpoints,
    snapshot.completedWaitpointOrder
  );
}

/**
 * Builds an EnhancedExecutionSnapshot from a snapshot and its unenhanced waitpoint rows. This is
 * the only place that expands a waitpoint over its `completedWaitpointOrder` positions, so every
 * backend produces the same runner payload.
 */
export function enhanceExecutionSnapshotWithWaitpoints(
  snapshot: ExecutionSnapshotWithCheckpoint,
  waitpoints: SnapshotReadWaitpoint[],
  completedWaitpointOrder: string[]
): EnhancedExecutionSnapshot {
  return {
    ...snapshot,
    friendlyId: SnapshotId.toFriendlyId(snapshot.id),
    runFriendlyId: RunId.toFriendlyId(snapshot.runId),
    completedWaitpoints: waitpoints.flatMap((w) => {
      // One waitpoint can fill several batch positions (the same idempotency key).
      let indexes: (number | undefined)[] = [];
      for (let i = 0; i < completedWaitpointOrder.length; i++) {
        if (completedWaitpointOrder[i] === w.id) {
          indexes.push(i);
        }
      }

      if (indexes.length === 0) {
        indexes.push(undefined);
      }

      return indexes.map((index) => {
        return {
          id: w.id,
          index: index === -1 ? undefined : index,
          friendlyId: w.friendlyId,
          type: w.type,
          completedAt: w.completedAt ?? new Date(),
          idempotencyKey:
            w.userProvidedIdempotencyKey && !w.inactiveIdempotencyKey
              ? w.idempotencyKey
              : undefined,
          completedByTaskRun: w.completedByTaskRunId
            ? {
                id: w.completedByTaskRunId,
                friendlyId: RunId.toFriendlyId(w.completedByTaskRunId),
                batch: snapshot.batchId
                  ? {
                      id: snapshot.batchId,
                      friendlyId: BatchId.toFriendlyId(snapshot.batchId),
                    }
                  : undefined,
              }
            : undefined,
          completedAfter: w.completedAfter ?? undefined,
          completedByBatch: w.completedByBatchId
            ? {
                id: w.completedByBatchId,
                friendlyId: BatchId.toFriendlyId(w.completedByBatchId),
              }
            : undefined,
          output: w.output ?? undefined,
          outputType: w.outputType,
          outputIsError: w.outputIsError,
        } satisfies CompletedWaitpoint;
      });
    }),
  };
}

/** Waitpoint ids of a snapshot. Raw SQL without a `runStore`; MemoryDB for a redis-primary run. */
async function getSnapshotWaitpointIds(
  prisma: PrismaClientOrTransaction,
  snapshotId: string,
  runStore?: RunStore,
  // Lets the router read the run's own store instead of both run-ops DBs.
  runId?: string,
  organizationId?: SnapshotReadContext
): Promise<string[]> {
  if (runStore) {
    return runStore.findSnapshotCompletedWaitpointIds(snapshotId, prisma, runId, organizationId);
  }

  const result = await prisma.$queryRaw<{ B: string }[]>`
    SELECT "B" FROM "_completedWaitpoints" WHERE "A" = ${snapshotId}
  `;
  return result.map((r) => r.B);
}

// One query, so the ids and the snapshot's presence come from the same reader state.
// `present: false` means this reader lacks the snapshot, so its empty id list is not authoritative.
async function getSnapshotWaitpointIdsWithPresence(
  prisma: PrismaClientOrTransaction,
  snapshotId: string,
  runStore?: RunStore,
  runId?: string,
  organizationId?: SnapshotReadContext
): Promise<{ present: boolean; ids: string[] }> {
  if (runStore) {
    return runStore.findSnapshotCompletedWaitpointIdsWithPresence(
      snapshotId,
      prisma,
      runId,
      organizationId
    );
  }

  const rows = await prisma.$queryRaw<{ id: string; B: string | null }[]>`
    SELECT s."id", cw."B"
    FROM "TaskRunExecutionSnapshot" s
    LEFT JOIN "_completedWaitpoints" cw ON cw."A" = s."id"
    WHERE s."id" = ${snapshotId}
  `;
  return {
    present: rows.length > 0,
    ids: rows.filter((r) => r.B !== null).map((r) => r.B as string),
  };
}

async function fetchWaitpointsInChunks(
  prisma: PrismaClientOrTransaction,
  waitpointIds: string[],
  runStore?: RunStore,
  // Lets the router read the run's own store, and the other DB only for a cross-tree token.
  runId?: string
): Promise<Waitpoint[]> {
  if (waitpointIds.length === 0) return [];

  const allWaitpoints: Waitpoint[] = [];
  for (let i = 0; i < waitpointIds.length; i += WAITPOINT_CHUNK_SIZE) {
    const chunk = waitpointIds.slice(i, i + WAITPOINT_CHUNK_SIZE);
    const waitpoints = runStore
      ? await runStore.findManyWaitpoints(
          { where: { id: { in: boundedIn(chunk) } } },
          prisma,
          runId
        )
      : await prisma.waitpoint.findMany({
          where: { id: { in: boundedIn(chunk) } },
        });
    allWaitpoints.push(...waitpoints);
  }
  return allWaitpoints;
}

/**
 * True when a snapshot read failed because a redis-primary run's state aged out and the run row is
 * final. Snapshot state only gets a TTL from a FINISHED entry, so a final row means the run finished.
 * Expired state on a non-final row is lost state and must keep failing closed.
 */
export function isExpiredSnapshotOfFinishedRun(error: unknown, runStatus: TaskRunStatus): boolean {
  return error instanceof SnapshotStateExpiredError && isFinalRunStatus(runStatus);
}

type FinishedRunRow<S extends Prisma.TaskRunSelect> = Prisma.TaskRunGetPayload<{
  select: S;
}> & { status: TaskRunStatus };

export type LatestExecutionSnapshotOrFinishedRun<S extends Prisma.TaskRunSelect> =
  | { snapshot: EnhancedExecutionSnapshot; finishedRun: null }
  | { snapshot: null; finishedRun: FinishedRunRow<S> };

/**
 * Like `getLatestExecutionSnapshot`, but returns the final run row (`runSelect` plus `status`) when
 * the snapshot state expired or the run has no snapshot. A run created already failed has no
 * snapshot. Any other error, or a non-final row, rethrows.
 */
export async function getLatestExecutionSnapshotOrFinishedRun<S extends Prisma.TaskRunSelect>(
  prisma: PrismaClientOrTransaction,
  runId: string,
  runStore: RunStore,
  organizationId: SnapshotReadContext | undefined,
  runSelect: S
): Promise<LatestExecutionSnapshotOrFinishedRun<S>> {
  try {
    const snapshot = await getLatestExecutionSnapshot(
      prisma,
      runId,
      runStore,
      undefined,
      organizationId
    );
    return { snapshot, finishedRun: null };
  } catch (error) {
    if (
      !(error instanceof SnapshotStateExpiredError) &&
      !(error instanceof LatestExecutionSnapshotNotFoundError)
    ) {
      throw error;
    }
    // Prisma cannot map a select over an intersection, so cast to the selection plus `status`.
    const run = (await runStore.findRun(
      { id: runId },
      { select: { ...runSelect, status: true } },
      prisma
    )) as FinishedRunRow<S> | null;
    if (!run || !isFinalRunStatus(run.status)) {
      throw error;
    }
    return { snapshot: null, finishedRun: run };
  }
}

/**
 * Returns the latest valid snapshot. With `environmentId`, a run in another environment throws a
 * 404, so its existence does not leak.
 */
export async function getLatestExecutionSnapshot(
  prisma: PrismaClientOrTransaction,
  runId: string,
  runStore?: RunStore,
  environmentId?: string,
  organizationId?: SnapshotReadContext
): Promise<EnhancedExecutionSnapshot> {
  const snapshot = runStore
    ? await runStore.findLatestExecutionSnapshot(runId, prisma, environmentId, organizationId)
    : await prisma.taskRunExecutionSnapshot.findFirst({
        where: { runId, isValid: true, ...(environmentId ? { environmentId } : {}) },
        include: {
          completedWaitpoints: true,
          checkpoint: true,
        },
        orderBy: { createdAt: "desc" },
      });

  if (!snapshot) {
    if (environmentId) {
      throw new ServiceValidationError(`No execution snapshot found for TaskRun ${runId}`, 404);
    }
    throw new LatestExecutionSnapshotNotFoundError(runId);
  }

  return enhanceExecutionSnapshot(snapshot);
}

export function executionResultFromSnapshot(snapshot: TaskRunExecutionSnapshot): ExecutionResult {
  return {
    snapshot: {
      id: snapshot.id,
      friendlyId: SnapshotId.toFriendlyId(snapshot.id),
      executionStatus: snapshot.executionStatus,
      description: snapshot.description,
      createdAt: snapshot.createdAt,
    },
    run: {
      id: snapshot.runId,
      friendlyId: RunId.toFriendlyId(snapshot.runId),
      status: snapshot.runStatus,
      attemptNumber: snapshot.attemptNumber,
    },
  };
}

export function executionDataFromSnapshot(snapshot: EnhancedExecutionSnapshot): RunExecutionData {
  return {
    version: "1" as const,
    snapshot: {
      id: snapshot.id,
      friendlyId: snapshot.friendlyId,
      executionStatus: snapshot.executionStatus,
      description: snapshot.description,
      createdAt: snapshot.createdAt,
    },
    run: {
      id: snapshot.runId,
      friendlyId: snapshot.runFriendlyId,
      status: snapshot.runStatus,
      attemptNumber: snapshot.attemptNumber ?? undefined,
    },
    batch: snapshot.batchId
      ? {
          id: snapshot.batchId,
          friendlyId: BatchId.toFriendlyId(snapshot.batchId),
        }
      : undefined,
    checkpoint: snapshot.checkpoint
      ? {
          id: snapshot.checkpoint.id,
          friendlyId: snapshot.checkpoint.friendlyId,
          type: snapshot.checkpoint.type,
          location: snapshot.checkpoint.location,
          imageRef: snapshot.checkpoint.imageRef,
          reason: snapshot.checkpoint.reason ?? undefined,
        }
      : undefined,
    completedWaitpoints: snapshot.completedWaitpoints,
  };
}

/**
 * Returns at most the 50 newest valid snapshots after `sinceSnapshotId`, oldest first. Only the
 * latest one carries its completed waitpoints. The runner ignores them on older snapshots, and
 * loading them for every snapshot (N×M) exceeds the NAPI string limit.
 */
export async function getExecutionSnapshotsSince(
  prisma: PrismaClientOrTransaction,
  runId: string,
  sinceSnapshotId: string,
  runStore?: RunStore,
  // The primary, for read-repair when `prisma` is a lagging replica.
  repairClient?: PrismaClientOrTransaction,
  // Scopes both reads to this environment. A run in another environment reads as not-found.
  environmentId?: string,
  organizationId?: string
): Promise<EnhancedExecutionSnapshot[]> {
  const envScope = environmentId ? { environmentId } : {};

  const sinceSnapshot = runStore
    ? await runStore.findExecutionSnapshot(
        {
          where: { id: sinceSnapshotId, runId, ...envScope },
          select: { createdAt: true, organizationId: true, metadata: true },
        },
        prisma,
        organizationId
      )
    : await prisma.taskRunExecutionSnapshot.findFirst({
        where: { id: sinceSnapshotId, runId, ...envScope },
        select: { createdAt: true, organizationId: true, metadata: true },
      });

  if (!sinceSnapshot) {
    throw new ExecutionSnapshotNotFoundError(sinceSnapshotId);
  }

  const snapshotContext = snapshotRouteFromSnapshot(sinceSnapshot);

  const snapshots = runStore
    ? await runStore.findManyExecutionSnapshots(
        {
          where: {
            runId,
            isValid: true,
            createdAt: { gt: sinceSnapshot.createdAt },
            ...envScope,
          },
          include: {
            checkpoint: true,
            // Do not include completedWaitpoints (N×M, see the function doc).
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        },
        prisma,
        snapshotContext
      )
    : await prisma.taskRunExecutionSnapshot.findMany({
        where: {
          runId,
          isValid: true,
          createdAt: { gt: sinceSnapshot.createdAt },
          ...envScope,
        },
        include: {
          checkpoint: true,
          // Do not include completedWaitpoints (N×M, see the function doc).
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });

  if (snapshots.length === 0) return [];

  const latestSnapshot = snapshots[0];
  let readClient = prisma;
  const { present, ids } = await getSnapshotWaitpointIdsWithPresence(
    prisma,
    latestSnapshot.id,
    runStore,
    runId,
    snapshotRouteFromSnapshot(latestSnapshot)
  );
  let waitpointIds = ids;

  // Read-repair: a laggier reader can lack this snapshot, so its empty id list is not
  // authoritative. The runner drops a continue with no waitpoints, and the run hangs.
  if (repairClient && repairClient !== prisma && !present) {
    waitpointIds = await getSnapshotWaitpointIds(
      repairClient,
      latestSnapshot.id,
      runStore,
      runId,
      snapshotRouteFromSnapshot(latestSnapshot)
    );
    readClient = repairClient;
  }

  // Read-repair: completedWaitpointOrder is on the snapshot row, so it is authoritative. Fewer
  // join ids means stale join rows on a lagging replica. Compare distinct ids: the order can repeat
  // an id (one idempotency key), but the join cannot.
  const expectedCount = new Set(latestSnapshot.completedWaitpointOrder ?? []).size;
  if (repairClient && repairClient !== prisma && waitpointIds.length < expectedCount) {
    const repaired = await getSnapshotWaitpointIds(
      repairClient,
      latestSnapshot.id,
      runStore,
      runId,
      snapshotRouteFromSnapshot(latestSnapshot)
    );
    if (repaired.length > waitpointIds.length) {
      waitpointIds = repaired;
      readClient = repairClient;
    }
  }

  let waitpoints = await fetchWaitpointsInChunks(readClient, waitpointIds, runStore, runId);

  if (repairClient && readClient !== repairClient && waitpoints.length < waitpointIds.length) {
    const fetchedIds = new Set(waitpoints.map((w) => w.id));
    const missingIds = waitpointIds.filter((id) => !fetchedIds.has(id));
    waitpoints = waitpoints.concat(
      await fetchWaitpointsInChunks(repairClient, missingIds, runStore, runId)
    );
  }

  return snapshots.reverse().map((snapshot) => {
    const isLatest = snapshot.id === latestSnapshot.id;
    return enhanceExecutionSnapshotWithWaitpoints(
      snapshot,
      isLatest ? waitpoints : [],
      latestSnapshot.completedWaitpointOrder
    );
  });
}

export class ExecutionSnapshotSystem {
  private readonly $: SystemResources;
  private readonly heartbeatTimeouts: HeartbeatTimeouts;

  constructor(private readonly options: ExecutionSnapshotSystemOptions) {
    this.$ = options.resources;
    this.heartbeatTimeouts = options.heartbeatTimeouts;
  }

  public async createExecutionSnapshot(
    prisma: PrismaClientOrTransaction,
    {
      snapshotId,
      run,
      snapshot,
      previousSnapshotId,
      snapshotRoute,
      batchId,
      environmentId,
      environmentType,
      projectId,
      organizationId,
      checkpointId,
      workerId,
      runnerId,
      completedWaitpoints,
      resolveCompletedWaitpointRecords,
      error,
    }: {
      /**
       * Transition id. Supply it only to key a publish guard before the write. Never reuse it for
       * different data: the insert ignores conflicts, so the new data is silently dropped.
       */
      snapshotId?: string;
      run: { id: string; status: TaskRunStatus; attemptNumber?: number | null };
      snapshot: {
        executionStatus: TaskRunExecutionStatus;
        description: string;
        metadata?: Prisma.JsonValue;
      };
      previousSnapshotId?: string;
      snapshotRoute?: SnapshotRouteWire;
      batchId?: string;
      environmentId: string;
      environmentType: RuntimeEnvironmentType;
      projectId: string;
      organizationId: string;
      checkpointId?: string;
      workerId?: string;
      runnerId?: string;
      completedWaitpoints?: {
        id: string;
        index?: number;
      }[];
      // Full records for a redis-primary completed-waitpoint cycle. The store calls it only for a
      // redis-primary snapshot. See `#completedWaitpointRecordsResolver` in waitpointSystem.ts.
      resolveCompletedWaitpointRecords?: () => Promise<CompletedWaitpointRecord[]>;
      error?: string;
    },
    // Set inside runStore.runInTransaction (`prisma` is then its tx), so a failure also rolls back
    // the sibling write. Unset, the router picks the store.
    store?: RunStore
  ) {
    // Minted above the store, so a retry inside the store replays the same transition idempotently.
    const id = snapshotId ?? SnapshotId.generate().id;

    const newSnapshot = await (store ?? this.$.runStore).createExecutionSnapshot(
      {
        id,
        run,
        snapshot,
        previousSnapshotId,
        snapshotRoute,
        batchId,
        environmentId,
        environmentType,
        projectId,
        organizationId,
        checkpointId,
        workerId,
        runnerId,
        completedWaitpoints,
        resolveCompletedWaitpointRecords,
        error,
      },
      prisma
    );

    if (!error) {
      const intervalMs = this.#getHeartbeatIntervalMs(newSnapshot.executionStatus);
      if (intervalMs !== null) {
        await this.$.worker.enqueue({
          id: `heartbeatSnapshot.${run.id}`,
          job: "heartbeatSnapshot",
          payload: { snapshotId: newSnapshot.id, runId: run.id },
          availableAt: new Date(Date.now() + intervalMs),
        });
      }
    }

    this.$.eventBus.emit("executionSnapshotCreated", {
      time: newSnapshot.createdAt,
      run: {
        id: newSnapshot.runId,
      },
      snapshot: {
        ...newSnapshot,
        completedWaitpointIds: completedWaitpoints?.map((w) => w.id) ?? [],
      },
    });

    return {
      ...newSnapshot,
      friendlyId: SnapshotId.toFriendlyId(newSnapshot.id),
      runFriendlyId: RunId.toFriendlyId(newSnapshot.runId),
    };
  }

  public async heartbeatRun({
    runId,
    snapshotId,
    organizationId,
    workerId,
    runnerId,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    organizationId?: string;
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<ExecutionResult> {
    const prisma = tx ?? this.$.prisma;

    // No run lock: a heartbeat against an older snapshot is harmless.
    let latestSnapshot: EnhancedExecutionSnapshot;
    try {
      latestSnapshot = await getLatestExecutionSnapshot(
        prisma,
        runId,
        this.$.runStore,
        undefined,
        organizationId
      );
    } catch (error) {
      // A transient store outage must not let the heartbeat lapse, or every live run stalls after
      // it. Expired state (a finished run) is not an outage.
      if (
        error instanceof SnapshotReadUnavailableError &&
        !(error instanceof SnapshotStateExpiredError) &&
        error.retriable === true
      ) {
        const intervalMs = this.#getHeartbeatIntervalMs("EXECUTING");
        if (intervalMs !== null) {
          await this.$.worker
            .reschedule(`heartbeatSnapshot.${runId}`, new Date(Date.now() + intervalMs))
            .catch((rescheduleError) => {
              this.$.logger.error("heartbeatRun: failed to extend the heartbeat", {
                runId,
                snapshotId,
                error: rescheduleError,
              });
            });
        }
        this.$.logger.warn(
          "heartbeatRun: snapshot store unavailable, extending the heartbeat without verifying the snapshot",
          { runId, snapshotId, workerId, runnerId }
        );
      }
      throw error;
    }
    if (latestSnapshot.id !== snapshotId) {
      this.$.logger.log("heartbeatRun: no longer the latest snapshot, stopping the heartbeat.", {
        runId,
        snapshotId,
        latestSnapshotId: latestSnapshot.id,
        latestSnapshotExecutionStatus: latestSnapshot.executionStatus,
        workerId,
        runnerId,
      });

      return executionResultFromSnapshot(latestSnapshot);
    }

    if (latestSnapshot.workerId && latestSnapshot.workerId !== workerId) {
      this.$.logger.debug("heartbeatRun: worker ID does not match the latest snapshot", {
        runId,
        snapshotId,
        latestSnapshotWorkerId: latestSnapshot.workerId,
        workerId,
        runnerId,
      });
    }

    this.$.logger.debug("heartbeatRun snapshot heartbeat updated", {
      id: latestSnapshot.id,
      runId: latestSnapshot.runId,
      lastHeartbeatAt: new Date(),
    });

    const intervalMs = this.#getHeartbeatIntervalMs(latestSnapshot.executionStatus);
    if (intervalMs !== null) {
      await this.$.worker.reschedule(
        `heartbeatSnapshot.${runId}`,
        new Date(Date.now() + intervalMs)
      );
    }

    return executionResultFromSnapshot(latestSnapshot);
  }

  public async restartHeartbeatForRun({
    runId,
    organizationId,
    delayMs,
    restartAttempt,
    tx,
  }: {
    runId: string;
    organizationId?: string;
    delayMs: number;
    restartAttempt: number;
    tx?: PrismaClientOrTransaction;
  }): Promise<ExecutionResult> {
    const prisma = tx ?? this.$.prisma;

    const latestSnapshot = await getLatestExecutionSnapshot(
      prisma,
      runId,
      this.$.runStore,
      undefined,
      organizationId
    );

    this.$.logger.debug("restartHeartbeatForRun: enqueuing heartbeat", {
      runId,
      snapshotId: latestSnapshot.id,
      delayMs,
    });

    await this.$.worker.enqueue({
      id: `heartbeatSnapshot.${runId}`,
      job: "heartbeatSnapshot",
      payload: { snapshotId: latestSnapshot.id, runId, restartAttempt },
      availableAt: new Date(Date.now() + delayMs),
    });

    return executionResultFromSnapshot(latestSnapshot);
  }

  /**
   * Enqueues the heartbeat that createExecutionSnapshot would, for a snapshot created another way
   * (for example, nested in a taskRun.update()).
   */
  public async enqueueHeartbeatIfNeeded(snapshot: {
    id: string;
    runId: string;
    executionStatus: TaskRunExecutionStatus;
  }) {
    const intervalMs = this.#getHeartbeatIntervalMs(snapshot.executionStatus);
    if (intervalMs !== null) {
      await this.$.worker.enqueue({
        id: `heartbeatSnapshot.${snapshot.runId}`,
        job: "heartbeatSnapshot",
        payload: { snapshotId: snapshot.id, runId: snapshot.runId },
        availableAt: new Date(Date.now() + intervalMs),
      });
    }
  }

  #getHeartbeatIntervalMs(status: TaskRunExecutionStatus): number | null {
    switch (status) {
      case "PENDING_EXECUTING": {
        return this.heartbeatTimeouts.PENDING_EXECUTING;
      }
      case "PENDING_CANCEL": {
        return this.heartbeatTimeouts.PENDING_CANCEL;
      }
      case "EXECUTING": {
        return this.heartbeatTimeouts.EXECUTING;
      }
      case "EXECUTING_WITH_WAITPOINTS": {
        return this.heartbeatTimeouts.EXECUTING_WITH_WAITPOINTS;
      }
      case "SUSPENDED": {
        return this.heartbeatTimeouts.SUSPENDED;
      }
      default: {
        return null;
      }
    }
  }
}
