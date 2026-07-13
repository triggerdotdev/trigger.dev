import { isCancellableRunStatus, isFinalRunStatus, isPendingRunStatus } from "~/v3/taskStatus";
import type { ListedRun } from "~/services/runsRepository/runsRepository.server";

export function mapRunToLiveFields(run: ListedRun) {
  const hasFinished = isFinalRunStatus(run.status);
  const startedAt = run.startedAt ?? run.lockedAt;

  return {
    friendlyId: run.friendlyId,
    status: run.status,
    updatedAt: run.updatedAt.toISOString(),
    startedAt: startedAt?.toISOString(),
    finishedAt: hasFinished
      ? (run.completedAt?.toISOString() ?? run.updatedAt.toISOString())
      : undefined,
    hasFinished,
    isCancellable: isCancellableRunStatus(run.status),
    isPending: isPendingRunStatus(run.status),
    usageDurationMs: Number(run.usageDurationMs),
    costInCents: run.costInCents,
    baseCostInCents: run.baseCostInCents,
  };
}
