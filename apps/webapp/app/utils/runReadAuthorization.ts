import type { RbacAbility, RbacResource } from "@trigger.dev/rbac";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";

type RunReadAliases = {
  friendlyId: string;
  taskIdentifier: string;
  runTags: string[];
  batchId: string | null;
};

export function canReadRunWithAliases(ability: RbacAbility, run: RunReadAliases): boolean {
  const resources: RbacResource[] = [
    { type: "runs", id: run.friendlyId },
    { type: "tasks", id: run.taskIdentifier },
    ...run.runTags.map((tag) => ({ type: "tags", id: tag })),
  ];

  if (run.batchId) {
    resources.push({ type: "batch", id: BatchId.toFriendlyId(run.batchId) });
  }

  return ability.can("read", resources);
}
