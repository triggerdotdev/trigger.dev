import { BatchId, generateRunOpsId, generateRunOpsIdV2 } from "@trigger.dev/core/v3/isomorphic";
import type { MintTarget } from "./mintTarget";
import { resolveRunMintTarget, type RunMintDeps } from "./resolveRunMintTarget.server";

export function batchIdForMintKind(target: MintTarget): { id: string; friendlyId: string } {
  if (target.kind !== "runOpsId") {
    return BatchId.generate();
  }

  const id = target.shardChar
    ? generateRunOpsIdV2(target.shardChar)
    : generateRunOpsId(target.region);

  return { id, friendlyId: BatchId.toFriendlyId(id) };
}

// A batch anchors on the parent run's id, never on another batch.
export async function resolveBatchMintKind(args: {
  environment: { organizationId: string; id: string; orgFeatureFlags?: unknown };
  parentRunFriendlyId?: string;
  deps?: Partial<RunMintDeps>;
}): Promise<MintTarget> {
  return resolveRunMintTarget({
    environment: args.environment,
    parentRunFriendlyId: args.parentRunFriendlyId,
    deps: args.deps,
  });
}

export async function mintBatchFriendlyId(args: {
  environment: { organizationId: string; id: string; orgFeatureFlags?: unknown };
  parentRunFriendlyId?: string;
  deps?: Partial<RunMintDeps>;
}): Promise<{ id: string; friendlyId: string }> {
  return batchIdForMintKind(await resolveBatchMintKind(args));
}
