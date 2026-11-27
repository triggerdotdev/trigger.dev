import type { RunStore } from "@internal/run-store";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import {
  isMemoryDbParent,
  refuseMemoryDbParentNotFound,
} from "~/v3/runOpsMigration/memoryDbParent.server";
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
  if (!parentRunId) {
    return;
  }
  // A MemoryDB parent is looked up even when the batch does not wait: it must exist to be inherited.
  if (!resumeParentOnCompletion && !isMemoryDbParent(parentRunId)) {
    return;
  }

  const runId = RunId.fromFriendlyId(parentRunId);
  const where = { id: runId, runtimeEnvironmentId: environmentId };
  const args = { select: { id: true } } as const;

  const parentRun =
    (await runStore.findRun(where, args)) ?? (await runStore.findRunOnPrimary(where, args));

  if (!parentRun) {
    refuseMemoryDbParentNotFound(parentRunId);
    throw new ServiceValidationError("Parent run not found in the calling environment", 404);
  }

  // Callers block a returned parent on the batch, so only a waiting batch returns one.
  return resumeParentOnCompletion ? parentRun.id : undefined;
}
