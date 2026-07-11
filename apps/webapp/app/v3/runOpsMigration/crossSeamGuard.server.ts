import { ownerEngine } from "@trigger.dev/core/v3/isomorphic";
import { isSplitEnabled } from "./splitMode.server";
import type {
  CrossSeamGuardDecision,
  CrossSeamGuardInput,
  RunOpsResidency,
  StoreTarget,
  UnblockRouteKind,
} from "./types";

const KNOWN_ROUTE_KINDS: ReadonlySet<UnblockRouteKind> = new Set<UnblockRouteKind>([
  "MANUAL",
  "DATETIME",
  "RESUME_TOKEN",
  "IDEMPOTENCY_REUSE",
  "RUN",
]);

// There is NO default store: an unrecognised route is a loud failure.
function assertKnownRouteKind(routeKind: UnblockRouteKind): void {
  if (!KNOWN_ROUTE_KINDS.has(routeKind)) {
    throw new Error(`Unknown unblock routeKind: ${JSON.stringify(routeKind)}`);
  }
}

function storeForResidency(residency: RunOpsResidency): StoreTarget {
  return residency === "NEW" ? "new" : "legacy";
}

/**
 * Pin precedence (deterministic, documented order):
 *   1. non-tree-owned          (treeOwnerResidency === "LEGACY")
 *   2. cross-tree-idempotency  (isCrossTreeIdempotency === true)
 *   3. legacy-parent-descendant (hasLegacyParent === true)
 * Any hit overrides the store to "legacy"; the waitpoint's own residency is
 * preserved on the decision so callers/metrics can see "NEW pinned to legacy".
 */
function applyPinningRules(
  input: CrossSeamGuardInput
): CrossSeamGuardDecision["pinnedReason"] | undefined {
  if (input.treeOwnerResidency === "LEGACY") return "non-tree-owned";
  if (input.isCrossTreeIdempotency === true) return "cross-tree-idempotency";
  if (input.hasLegacyParent === true) return "legacy-parent-descendant";
  return undefined;
}

/**
 * Pure store-selection core. No env import, no I/O — driven exhaustively by the
 * downstream proof harness via the optional `classify` seam.
 */
export function selectStoreForWaitpoint(
  input: CrossSeamGuardInput,
  deps?: { classify?: (id: string) => RunOpsResidency }
): CrossSeamGuardDecision {
  assertKnownRouteKind(input.routeKind);

  const classify = deps?.classify ?? ownerEngine;

  const residency: RunOpsResidency = classify(input.waitpointId);

  const pinnedReason = applyPinningRules(input);
  const store: StoreTarget = pinnedReason ? "legacy" : storeForResidency(residency);

  return {
    store,
    residency,
    routeKind: input.routeKind,
    ...(pinnedReason ? { pinnedReason } : {}),
  };
}

/**
 * Pure flag-aware core. In single-DB mode "legacy" IS the single store, so we
 * return it WITHOUT ever consulting the classifier (off in single-DB). When
 * split is on, delegate to the pure selection core.
 */
export function computeStoreForCompletion(
  input: CrossSeamGuardInput,
  opts: { splitEnabled: boolean; classify?: (id: string) => RunOpsResidency }
): CrossSeamGuardDecision {
  if (opts.splitEnabled === false) {
    return { store: "legacy", residency: "LEGACY", routeKind: input.routeKind };
  }
  return selectStoreForWaitpoint(input, { classify: opts.classify });
}

/** Thin server entry the waitpoint-completion consumers call. */
export async function pickRunOpsStoreForCompletion(
  input: CrossSeamGuardInput
): Promise<CrossSeamGuardDecision> {
  const splitEnabled = await isSplitEnabled();
  return computeStoreForCompletion(input, { splitEnabled });
}
