import type { RunStore } from "@internal/run-store";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import { ServiceValidationError } from "../../v3/services/baseService.server";

type BatchParentRunStore = Pick<RunStore, "findRun" | "findRunOnPrimary">;

export async function resolveBatchParentRun({
  runStore,
  environmentId,
  parentRunId,
  resumeParentOnCompletion,
}: {
  runStore: BatchParentRunStore;
  environmentId: string;
  parentRunId?: string;
  resumeParentOnCompletion?: boolean;
}): Promise<string | undefined> {
  if (!parentRunId || !resumeParentOnCompletion) {
    return;
  }

  const runId = RunId.fromFriendlyId(parentRunId);
  const where = { id: runId, runtimeEnvironmentId: environmentId };
  const args = { select: { id: true } } as const;

  const parentRun =
    (await runStore.findRun(where, args)) ?? (await runStore.findRunOnPrimary(where, args));

  if (!parentRun) {
    throw new ServiceValidationError("Parent run not found in the calling environment", 404);
  }

  return parentRun.id;
}
