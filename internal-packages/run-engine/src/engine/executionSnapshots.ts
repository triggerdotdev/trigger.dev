import { CompletedWaitpoint, ExecutionResult } from "@trigger.dev/core/v3";
import { BatchId, RunId, SnapshotId } from "@trigger.dev/core/v3/apps";
import {
  PrismaClientOrTransaction,
  TaskRunCheckpoint,
  TaskRunExecutionSnapshot,
} from "@trigger.dev/database";

interface LatestExecutionSnapshot extends TaskRunExecutionSnapshot {
  friendlyId: string;
  runFriendlyId: string;
  checkpoint: TaskRunCheckpoint | null;
  completedWaitpoints: CompletedWaitpoint[];
}

/* Gets the most recent valid snapshot for a run */
export async function getLatestExecutionSnapshot(
  prisma: PrismaClientOrTransaction,
  runId: string
): Promise<LatestExecutionSnapshot> {
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
