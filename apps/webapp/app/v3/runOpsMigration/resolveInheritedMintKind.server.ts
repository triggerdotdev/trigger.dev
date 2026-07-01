import { ownerEngine } from "@trigger.dev/core/v3/isomorphic";
import type { RunIdMintKind } from "./runOpsMintKind.server";

type InheritedMintKindDeps = {
  isSplitEnabled: () => Promise<boolean>;
  isKnownMigrated: (runId: string) => Promise<boolean>;
};

// Mint a child in the SAME physical store as its anchor (parent run / owning batch),
// regardless of the org's current mint flag — keeps a subgraph co-resident across a
// flip. Marker-aware inheritance only matters with split on; split off is a pure
// id-shape check (zero hot-path I/O, byte-identical to today).
export async function resolveInheritedMintKind(
  parentRunFriendlyId: string,
  deps: InheritedMintKindDeps
): Promise<RunIdMintKind> {
  if ((await deps.isSplitEnabled()) && (await deps.isKnownMigrated(parentRunFriendlyId))) {
    return "ksuid";
  }
  return ownerEngine(parentRunFriendlyId) === "NEW" ? "ksuid" : "cuid";
}
