import type { RbacAbility } from "@trigger.dev/rbac";

type ParentRunResource = {
  friendlyId: string;
  taskIdentifier: string;
};

export function canWriteResolvedParentRun(ability: RbacAbility, run: ParentRunResource): boolean {
  return ability.can("write", [
    { type: "runs", id: run.friendlyId },
    { type: "tasks", id: run.taskIdentifier },
  ]);
}
