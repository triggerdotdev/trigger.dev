import type { RbacAbility } from "@trigger.dev/plugins";
import type { UpdateMetadataRequestBody } from "@trigger.dev/core/v3";
import { ServiceValidationError } from "~/v3/services/common.server";

// Check every target before any writes or buffered ingestion, so a rejected
// parent/root operation cannot leave a partially applied request.
export function authorizeMetadataTargets(
  ability: RbacAbility,
  body: Pick<UpdateMetadataRequestBody, "parentOperations" | "rootOperations">,
  targets: { runId: string; parentRunId?: string; rootRunId?: string }
): void {
  const runIds = [targets.runId];
  if (body.parentOperations?.length) runIds.push(targets.parentRunId ?? targets.runId);
  if (body.rootOperations?.length) runIds.push(targets.rootRunId ?? targets.runId);

  if (!runIds.every((id) => ability.can("write", { type: "runs", id }))) {
    throw new ServiceValidationError("Unauthorized", 403);
  }
}
