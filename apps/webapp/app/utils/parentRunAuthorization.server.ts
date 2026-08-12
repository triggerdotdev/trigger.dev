import type { RbacAbility } from "@trigger.dev/rbac";
import { resolveRunForMutation } from "~/v3/mollifier/resolveRunForMutation.server";
import { canWriteResolvedParentRun } from "./parentRunAuthorization";

export async function canWriteParentRun(
  ability: RbacAbility,
  environmentId: string,
  organizationId: string,
  parentRunId: string | null | undefined
): Promise<boolean> {
  if (!parentRunId) return true;

  // A type-level `write:runs` grant covers every run in the environment, so
  // resolving the parent could only confirm what we already know. Root keys and
  // any other unrestricted credential take this branch, which keeps the trigger
  // hot path free of the extra lookup.
  if (ability.can("write", { type: "runs" })) return true;

  const run = await resolveRunForMutation({
    environmentId,
    organizationId,
    runParam: parentRunId,
  });
  if (!run) return false;

  return canWriteResolvedParentRun(ability, run);
}
