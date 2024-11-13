import { ExecutionResult } from "@trigger.dev/core/v3";
import { PrismaClientOrTransaction, TaskRunExecutionSnapshot } from "@trigger.dev/database";

/* Gets the most recent valid snapshot for a run */
export async function getLatestExecutionSnapshot(prisma: PrismaClientOrTransaction, runId: string) {
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
    completedWaitpoints: snapshot.completedWaitpoints.map((w) => ({
      id: w.id,
      type: w.type,
      completedAt: w.completedAt ?? new Date(),
      idempotencyKey:
        w.userProvidedIdempotencyKey && !w.inactiveIdempotencyKey ? w.idempotencyKey : undefined,
      completedByTaskRunId: w.completedByTaskRunId ?? undefined,
      completedAfter: w.completedAfter ?? undefined,
      output: w.output ?? undefined,
      outputType: w.outputType,
      outputIsError: w.outputIsError,
    })),
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
      executionStatus: snapshot.executionStatus,
      description: snapshot.description,
    },
    run: {
      id: snapshot.runId,
      status: snapshot.runStatus,
      attemptNumber: snapshot.attemptNumber,
    },
  };
}
