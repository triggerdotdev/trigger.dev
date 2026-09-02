import { generateRunOpsId, generateRunOpsIdV2, RunId } from "@trigger.dev/core/v3/isomorphic";
import type { MintTarget } from "./mintTarget";
import { resolveInheritedMintKind } from "./resolveInheritedMintKind.server";

// A shardChar selects one gen-2 shard and takes index 24; without one the region takes that slot.
export function mintFriendlyIdForKind(target: MintTarget): string {
  if (target.kind !== "runOpsId") {
    return RunId.generate().friendlyId;
  }

  return RunId.toFriendlyId(
    target.shardChar ? generateRunOpsIdV2(target.shardChar) : generateRunOpsId(target.region)
  );
}

// Anchor a batch item's mint on the BATCH's friendlyId (id-shape, zero I/O), never the per-org
// flag, so the item and its BatchTaskRun stay co-resident across a mid-batch flag flip.
export function mintAnchoredRunFriendlyId(batchFriendlyId: string, region?: string): string {
  return mintFriendlyIdForKind({ ...resolveInheritedMintKind(batchFriendlyId), region });
}
