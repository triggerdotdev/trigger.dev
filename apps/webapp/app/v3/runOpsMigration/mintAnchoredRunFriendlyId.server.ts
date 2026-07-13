import { generateRunOpsId, RunId, type ResidencyKind } from "@trigger.dev/core/v3/isomorphic";
import { resolveInheritedMintKind } from "./resolveInheritedMintKind.server";

// Shared id-generation branch for every run-mint path: "runOpsId" -> NEW store, "cuid" -> LEGACY.
export function mintFriendlyIdForKind(mintKind: ResidencyKind, region?: string): string {
  return mintKind === "runOpsId"
    ? RunId.toFriendlyId(generateRunOpsId(region))
    : RunId.generate().friendlyId;
}

// Anchor a batch item's mint on the BATCH's friendlyId (id-shape, zero I/O), never the per-org
// flag, so the item and its BatchTaskRun stay co-resident across a mid-batch flag flip.
export function mintAnchoredRunFriendlyId(batchFriendlyId: string, region?: string): string {
  return mintFriendlyIdForKind(resolveInheritedMintKind(batchFriendlyId), region);
}
