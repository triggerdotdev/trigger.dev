import { ownerEngine } from "@trigger.dev/core/v3/isomorphic";
import type { RunIdMintKind } from "./runOpsMintKind.server";

// Mint a child in the SAME physical store as its anchor (parent run / owning batch),
// regardless of the org's current mint flag — keeps a subgraph co-resident across a
// flip. With no migration/drain, residency is a pure id-shape check (zero hot-path
// I/O): a run-ops (NEW) parent mints run-ops children, a cuid (LEGACY) parent mints cuid.
export function resolveInheritedMintKind(parentRunFriendlyId: string): RunIdMintKind {
  return ownerEngine(parentRunFriendlyId) === "NEW" ? "runOpsId" : "cuid";
}
