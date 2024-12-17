import { CompletedWaitpoint, ExecutionResult } from "@trigger.dev/core/v3";
import { RunId, SnapshotId } from "@trigger.dev/core/v3/apps";
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
    completedWaitpoints: snapshot.completedWaitpoints.map(
      (w) =>
        ({
          id: w.id,
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
              }
            : undefined,
          completedAfter: w.completedAfter ?? undefined,
          output: w.output ?? undefined,
          outputType: w.outputType,
          outputIsError: w.outputIsError,
        }) satisfies CompletedWaitpoint
    ),
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