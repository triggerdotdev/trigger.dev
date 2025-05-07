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
} from "@trigger.dev/database";
import { HeartbeatTimeouts } from "../types.js";
import { SystemResources } from "./systems.js";

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

function enhanceExecutionSnapshot(
  snapshot: ExecutionSnapshotWithCheckAndWaitpoints
): EnhancedExecutionSnapshot {
  return {
    ...snapshot,
    friendlyId: SnapshotId.toFriendlyId(snapshot.id),
    runFriendlyId: RunId.toFriendlyId(snapshot.runId),
    completedWaitpoints: snapshot.completedWaitpoints.flatMap((w) => {
      //get all indexes of the waitpoint in the completedWaitpointOrder
      //we do this because the same run can be in a batch multiple times (i.e. same idempotencyKey)
      let indexes: (number | undefined)[] = [];
      for (let i = 0; i < snapshot.completedWaitpointOrder.length; i++) {
        if (snapshot.completedWaitpointOrder[i] === w.id) {
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

export async function getExecutionSnapshotsSince(
  prisma: PrismaClientOrTransaction,
  runId: string,
  sinceSnapshotId: string
): Promise<EnhancedExecutionSnapshot[]> {
  // Find the createdAt of the sinceSnapshotId
  const sinceSnapshot = await prisma.taskRunExecutionSnapshot.findFirst({
    where: { id: sinceSnapshotId },
    select: { createdAt: true },
  });

  if (!sinceSnapshot) {
    throw new Error(`No execution snapshot found for id ${sinceSnapshotId}`);
  }

  const snapshots = await prisma.taskRunExecutionSnapshot.findMany({
    where: {
      runId,
      isValid: true,
      createdAt: { gt: sinceSnapshot.createdAt },
    },
    include: {
      completedWaitpoints: true,
      checkpoint: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return snapshots.map(enhanceExecutionSnapshot);
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
        runStatus: run.status,
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

      await this.$.worker.ack(`heartbeatSnapshot.${runId}`);
      return executionResultFromSnapshot(latestSnapshot);
    }

    if (latestSnapshot.workerId !== workerId) {
      this.$.logger.debug("heartbeatRun: worker ID does not match the latest snapshot", {
        runId,
        snapshotId,
        latestSnapshot,
        workerId,
        runnerId,
      });
    }

    //update the snapshot heartbeat time
    await prisma.taskRunExecutionSnapshot.update({
      where: { id: latestSnapshot.id },
      data: {
        lastHeartbeatAt: new Date(),
      },
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
      default: {
        return null;
      }
    }
  }
}
