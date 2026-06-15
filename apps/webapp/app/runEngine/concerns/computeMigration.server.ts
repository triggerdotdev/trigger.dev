import { hashBucket } from "~/utils/computeBucket";

/** Subset of the global flags snapshot this resolver reads. */
export type ComputeMigrationFlags = {
  computeMigrationEnabled?: boolean;
  computeMigrationFreePercentage?: number;
  computeMigrationPaidPercentage?: number;
};

export type ComputeBackingMap = Record<string, string>;

/**
 * Parse COMPUTE_BACKING_MAP (container-region masterQueue -> compute-backing
 * masterQueue). Never throws: bad JSON or non-string values yield {} so a
 * misconfigured env disables migration rather than breaking triggers.
 */
export function parseComputeBackingMap(raw: string): ComputeBackingMap {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: ComputeBackingMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Inverse of the backing map: given a worker queue, return the user-facing geo
 * region. If the queue is a compute backing (a *value* in the map), return the
 * region it backs; otherwise return the queue unchanged. Used to hide the
 * backing on customer surfaces and to re-derive the region on replay.
 */
export function regionForBacking(queue: string, backingMap: ComputeBackingMap): string {
  for (const [region, backing] of Object.entries(backingMap)) {
    if (backing === queue) return region;
  }
  return queue;
}

type MigrationDecisionInput = {
  planType: string | undefined;
  orgId: string;
  orgFeatureFlags: Record<string, unknown> | null | undefined;
  flags: ComputeMigrationFlags | undefined;
};

/**
 * Whether this org should run on the compute backing. Shared by the trigger-time
 * transform and the deploy-time template decision so a migrated org always gets a
 * compute template. Precedence: per-org override (both directions) wins; otherwise
 * global enable + the plan's percentage bucket. Enterprise and unknown plans are
 * never enrolled by percentage (override only). The sole opt-out is the per-org
 * `computeMigrationEnabled: false`.
 */
export function isOrgMigrated({
  planType,
  orgId,
  orgFeatureFlags,
  flags,
}: MigrationDecisionInput): boolean {
  const override = orgFeatureFlags?.["computeMigrationEnabled"];
  if (override === false) return false;
  if (override === true) return true;

  if (!(flags?.computeMigrationEnabled ?? false)) return false;

  const pct =
    planType === "free"
      ? flags?.computeMigrationFreePercentage ?? 0
      : planType === "paid"
      ? flags?.computeMigrationPaidPercentage ?? 0
      : 0; // enterprise / undefined

  return hashBucket(orgId) < pct;
}

type ResolveInput = MigrationDecisionInput & {
  baseWorkerQueue: string | undefined;
  envType: string;
  backingMap: ComputeBackingMap;
};

/**
 * Rewrite the resolved worker queue to its compute backing when the org is
 * migrated and the region has a backing. Same-geo swap (us-east-1 -> us-east-1-next):
 * any explicit placement is a geography preference, honored by staying in-region.
 * Applied after region resolution, mirroring the scheduled-split.
 */
export function resolveComputeMigration({
  baseWorkerQueue,
  envType,
  backingMap,
  ...decision
}: ResolveInput): string | undefined {
  if (baseWorkerQueue === undefined) return baseWorkerQueue;
  if (envType === "DEVELOPMENT") return baseWorkerQueue;
  if (!isOrgMigrated(decision)) return baseWorkerQueue;
  return backingMap[baseWorkerQueue] ?? baseWorkerQueue;
}
