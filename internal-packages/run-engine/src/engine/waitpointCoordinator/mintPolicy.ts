import type { SnapshotResidency } from "@internal/run-store";

/** The per-organization setting. Consulted ONLY when minting a new waitpoint, never on an existing id. */
export type WaitpointMintMode = "legacy" | "redis";

/** Where a waitpoint's coordinator lives. Selected once at mint, then fixed by the id's shape forever. */
export type WaitpointResidency = "legacy" | "store";

export type WaitpointMintType = "RUN" | "BATCH" | "DATETIME" | "MANUAL";

/**
 * The single blocking reason, in precedence order, that pushed a mint to legacy — or `enabled` when
 * the store was chosen. Bounded so it can label a metric without a high-cardinality org id.
 */
type WaitpointMintReason = "org-disabled" | "ineligible-type" | "capability-not-ready" | "enabled";

export type WaitpointMintDecisionInput = {
  /** The organization's `waitpointMintMode`. */
  mintMode: WaitpointMintMode;
  /** Optional compatibility hint from older callers; snapshot residency does not gate minting. */
  parentResidency?: SnapshotResidency;
  waitpointType: WaitpointMintType;
  /** The shared MemoryDB waitpoint capability readiness for the current application-version mix. */
  capabilityReady: boolean;
  /** Defaults to {@link DEFAULT_ELIGIBLE_WAITPOINT_TYPES}. A call site may override it explicitly. */
  eligibleTypes?: ReadonlySet<WaitpointMintType>;
};

export type WaitpointMintDecision = {
  residency: WaitpointResidency;
  reason: WaitpointMintReason;
};

/** Initial migration eligibility. MANUAL and BATCH waitpoint migration is deferred. */
export const DEFAULT_ELIGIBLE_WAITPOINT_TYPES: ReadonlySet<WaitpointMintType> =
  new Set<WaitpointMintType>(["RUN", "DATETIME"]);

/**
 * The pure mint-selection policy. Chooses the store ONLY when the organization opted in, the type is
 * eligible, and the shared capability is ready. Snapshot residency is an independent rollout.
 * Anything else mints legacy, and the returned reason names the first unmet condition.
 *
 * Deliberately total and side-effect free: it reads no clock, no store, no config; a mixed-version
 * fleet's readiness is passed in, not probed here.
 */
export function decideWaitpointResidency(input: WaitpointMintDecisionInput): WaitpointMintDecision {
  if (input.mintMode !== "redis") {
    return { residency: "legacy", reason: "org-disabled" };
  }

  const eligibleTypes = input.eligibleTypes ?? DEFAULT_ELIGIBLE_WAITPOINT_TYPES;
  if (!eligibleTypes.has(input.waitpointType)) {
    return { residency: "legacy", reason: "ineligible-type" };
  }

  if (!input.capabilityReady) {
    return { residency: "legacy", reason: "capability-not-ready" };
  }

  return { residency: "store", reason: "enabled" };
}
