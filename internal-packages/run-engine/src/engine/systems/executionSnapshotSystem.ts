import { CompletedWaitpoint, ExecutionResult, RunExecutionData } from "@trigger.dev/core/v3";
import { BatchId, RunId, SnapshotId } from "@trigger.dev/core/v3/isomorphic";
import {
  Prisma,
  PrismaClientOrTransaction,
  RuntimeEnvironmentType,
  TaskRunCheckpoint,
  TaskRunExecutionSnapshot,
  TaskRunExecutionStatus,
  TaskRunStatus,
  Waitpoint,
} from "@trigger.dev/database";
import { HeartbeatTimeouts } from "../types.js";
import { SystemResources } from "./systems.js";

/** Chunk size for fetching waitpoints to avoid NAPI string conversion limits */
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

type ExecutionSnapshotWithCheckAndWaitpoints = Prisma.TaskRunExecutionSnapshotGetPayload<{
  include: {
    checkpoint: true;
    completedWaitpoints: true;
  };
}>;

type ExecutionSnapshotWithCheckpoint = Prisma.TaskRunExecutionSnapshotGetPayload<{
  include: {
    checkpoint: true;
  };
}>;

function enhanceExecutionSnapshot(
  snapshot: ExecutionSnapshotWithCheckAndWaitpoints
): EnhancedExecutionSnapshot {
  return enhanceExecutionSnapshotWithWaitpoints(
    snapshot,
    snapshot.completedWaitpoints,
    snapshot.completedWaitpointOrder
  );
}

/**
 * Transforms a snapshot (with checkpoint but without waitpoints) into an EnhancedExecutionSnapshot
 * by combining it with pre-fetched waitpoints.
 */
function enhanceExecutionSnapshotWithWaitpoints(
  snapshot: ExecutionSnapshotWithCheckpoint,
  waitpoints: Waitpoint[],
  completedWaitpointOrder: string[]
): EnhancedExecutionSnapshot {
  return {
    ...snapshot,
    friendlyId: SnapshotId.toFriendlyId(snapshot.id),
    runFriendlyId: RunId.toFriendlyId(snapshot.runId),
    completedWaitpoints: waitpoints.flatMap((w) => {
      // Get all indexes of the waitpoint in the completedWaitpointOrder
      // We do this because the same run can be in a batch multiple times (i.e. same idempotencyKey)
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
            w.userProvidedIdempotencyKey && !w.inactiveIdempotencyKey ? w.idempotencyKey : undefined,
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

/**
 * Gets the waitpoint IDs linked to a snapshot via the _completedWaitpoints join table.
 * Uses raw SQL to avoid fetching full waitpoint data.
 */
async function getSnapshotWaitpointIds(
  prisma: PrismaClientOrTransaction,
  snapshotId: string
): Promise<string[]> {
  const result = await prisma.$queryRaw<{ B: string }[]>`
    SELECT "B" FROM "_completedWaitpoints" WHERE "A" = ${snapshotId}
  `;
  return result.map((r) => r.B);
}

/**
 * Fetches waitpoints in chunks to avoid NAPI string conversion limits.
 * This is necessary because waitpoints can have large outputs (100KB+),
 * and fetching many at once can exceed Node.js string limits.
 */
async function fetchWaitpointsInChunks(
  prisma: PrismaClientOrTransaction,
  waitpointIds: string[]
): Promise<Waitpoint[]> {
  if (waitpointIds.length === 0) return [];

  const allWaitpoints: Waitpoint[] = [];
  for (let i = 0; i < waitpointIds.length; i += WAITPOINT_CHUNK_SIZE) {
    const chunk = waitpointIds.slice(i, i + WAITPOINT_CHUNK_SIZE);
    const waitpoints = await prisma.waitpoint.findMany({
      where: { id: { in: chunk } },
    });
    allWaitpoints.push(...waitpoints);
  }
  return allWaitpoints;
}

/* Gets the most recent valid snapshot for a run */
export async function getLatestExecutionSnapshot(
  prisma: PrismaClientOrTransaction,
  runId: string
): Promise<EnhancedExecutionSnapshot> {
  const snapshot = await prisma.taskRunExecutionSnapshot.findFirst({
    where: { runId, isValid: true },
    include: {
      completedWaitpoints: true,
      checkpoint: true,
    },
    orderBy: { createdAt: "desc" },
  });

  if (!snapshot) {
    throw new Error(`No execution snapshot found for TaskRun ${runId}`);
  }

  return enhanceExecutionSnapshot(snapshot);
}

export async function getExecutionSnapshotCompletedWaitpoints(
  prisma: PrismaClientOrTransaction,
  snapshotId: string
) {
  const waitpoints = await prisma.taskRunExecutionSnapshot.findFirst({
    where: { id: snapshotId },
    include: {
      completedWaitpoints: true,
    },
  });

  //deduplicate waitpoints
  const waitpointIds = new Set<string>();
  return (
    waitpoints?.completedWaitpoints.filter((waitpoint) => {
      if (waitpointIds.has(waitpoint.id)) {
        return false;
      } else {
        waitpointIds.add(waitpoint.id);
        return true;
      }
    }) ?? []
  );
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
 * Gets execution snapshots created after the specified snapshot.
 *
 * IMPORTANT: This function is optimized to avoid N×M data explosion when runs have many
 * completed waitpoints. Due to the many-to-many relation, once waitpoints complete,
 * all subsequent snapshots have the same waitpoints linked. For a run with 24 snapshots
 * and 236 waitpoints with 100KB outputs each, fetching all waitpoints for all snapshots
 * would result in ~570MB of data, causing "Failed to convert rust String into napi string" errors.
 *
 * Solution: Only the LATEST snapshot's waitpoints are fetched and included. The runner's
 * SnapshotManager only processes completedWaitpoints from the latest snapshot anyway -
 * intermediate snapshots' waitpoints are ignored. This reduces data from N×M to just M.
 *
 * Waitpoints are fetched in chunks (100 at a time) to handle batches up to 1000 items.
 */
export async function getExecutionSnapshotsSince(
  prisma: PrismaClientOrTransaction,
  runId: string,
  sinceSnapshotId: string
): Promise<EnhancedExecutionSnapshot[]> {
  // Step 1: Find the createdAt of the sinceSnapshotId
  const sinceSnapshot = await prisma.taskRunExecutionSnapshot.findFirst({
    where: { id: sinceSnapshotId },
    select: { createdAt: true },
  });

  if (!sinceSnapshot) {
    throw new Error(`No execution snapshot found for id ${sinceSnapshotId}`);
  }

  // Step 2: Fetch snapshots WITHOUT waitpoints to avoid N×M data explosion
  const snapshots = await prisma.taskRunExecutionSnapshot.findMany({
    where: {
      runId,
      isValid: true,
      createdAt: { gt: sinceSnapshot.createdAt },
    },
    include: {
      checkpoint: true,
      // DO NOT include completedWaitpoints here - this causes the N×M explosion
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  if (snapshots.length === 0) return [];

  // Step 3: Get waitpoint IDs for the LATEST snapshot only (first in desc order)
  const latestSnapshot = snapshots[0];
  const waitpointIds = await getSnapshotWaitpointIds(prisma, latestSnapshot.id);

  // Step 4: Fetch waitpoints in chunks to avoid NAPI string conversion limits
  const waitpoints = await fetchWaitpointsInChunks(prisma, waitpointIds);

  // Step 5: Build enhanced snapshots - only latest gets waitpoints, others get empty arrays
  // The runner only uses completedWaitpoints from the latest snapshot anyway
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
      run,
      snapshot,
      previousSnapshotId,
      batchId,
      environmentId,
      environmentType,
      projectId,
      organizationId,
      checkpointId,
      workerId,
      runnerId,
      completedWaitpoints,
      error,
    }: {
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
      completedWaitpoints?: {
        id: string;
        index?: number;
      }[];
      error?: string;
    }
  ) {
    const newSnapshot = await prisma.taskRunExecutionSnapshot.create({
      data: {
        engine: "V2",
        executionStatus: snapshot.executionStatus,
        description: snapshot.description,
        previousSnapshotId,
        runId: run.id,
        // We can't set the runStatus to DEQUEUED because it will break older runners
        runStatus: run.status === "DEQUEUED" ? "PENDING" : run.status,
        attemptNumber: run.attemptNumber ?? undefined,
        batchId,
        environmentId,
        environmentType,
        projectId,
        organizationId,
        checkpointId,
        workerId,
        runnerId,
        metadata: snapshot.metadata ?? undefined,
        completedWaitpoints: {
          connect: completedWaitpoints?.map((w) => ({ id: w.id })),
        },
        completedWaitpointOrder: completedWaitpoints
          ?.filter((c) => c.index !== undefined)
          .sort((a, b) => a.index! - b.index!)
          .map((w) => w.id),
        isValid: error ? false : true,
        error,
      },
      include: {
        checkpoint: true,
      },
    });

    if (!error) {
      //set heartbeat (if relevant)
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
    workerId,
    runnerId,
    tx,
  }: {
    runId: string;
    snapshotId: string;
    workerId?: string;
    runnerId?: string;
    tx?: PrismaClientOrTransaction;
  }): Promise<ExecutionResult> {
    const prisma = tx ?? this.$.prisma;

    //we don't need to acquire a run lock for any of this, it's not critical if it happens on an older version
    const latestSnapshot = await getLatestExecutionSnapshot(prisma, runId);
    if (latestSnapshot.id !== snapshotId) {
      this.$.logger.log("heartbeatRun: no longer the latest snapshot, stopping the heartbeat.", {
        runId,
        snapshotId,
        latestSnapshot,
        workerId,
        runnerId,
      });

      return executionResultFromSnapshot(latestSnapshot);
    }

    if (latestSnapshot.workerId && latestSnapshot.workerId !== workerId) {
      this.$.logger.debug("heartbeatRun: worker ID does not match the latest snapshot", {
        runId,
        snapshotId,
        latestSnapshot,
        workerId,
        runnerId,
      });
    }

    this.$.logger.info("heartbeatRun snapshot heartbeat updated", {
      id: latestSnapshot.id,
      runId: latestSnapshot.runId,
      lastHeartbeatAt: new Date(),
    });

    //extending the heartbeat
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
    delayMs,
    restartAttempt,
    tx,
  }: {
    runId: string;
    delayMs: number;
    restartAttempt: number;
    tx?: PrismaClientOrTransaction;
  }): Promise<ExecutionResult> {
    const prisma = tx ?? this.$.prisma;

    const latestSnapshot = await getLatestExecutionSnapshot(prisma, runId);

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
