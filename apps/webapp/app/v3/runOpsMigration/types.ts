// Pure types for the cross-seam residency guard. No runtime, no env, no Prisma.
import type { Residency } from "@trigger.dev/core/v3/isomorphic";

// Aliased (not re-declared) so it cannot drift from the classifier's own union.
export type RunOpsResidency = Residency;

export type StoreTarget = "new" | "legacy";

export type UnblockRouteKind = "MANUAL" | "DATETIME" | "RESUME_TOKEN" | "IDEMPOTENCY_REUSE" | "RUN";

export interface CrossSeamGuardInput {
  waitpointId: string;
  routeKind: UnblockRouteKind;
  treeOwnerResidency?: RunOpsResidency;
  isCrossTreeIdempotency?: boolean;
  hasLegacyParent?: boolean;
}

export interface CrossSeamGuardDecision {
  store: StoreTarget;
  /** Always the waitpoint's OWN classification, even when pinned to legacy. */
  residency: RunOpsResidency;
  routeKind: UnblockRouteKind;
  pinnedReason?: "non-tree-owned" | "cross-tree-idempotency" | "legacy-parent-descendant";
}
