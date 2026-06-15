import { hashBucket } from "~/utils/computeBucket";

/** Subset of the global flags snapshot this resolver reads. */
export type ComputeMigrationFlags = {
  computeMigrationEnabled?: boolean;
  computeMigrationFreePercentage?: number;
  computeMigrationPaidPercentage?: number;
};

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
  backing: string | undefined; // the compute backing for this queue's region, or undefined
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
  backing,
  ...decision
}: ResolveInput): string | undefined {
  if (baseWorkerQueue === undefined) return baseWorkerQueue;
  if (envType === "DEVELOPMENT") return baseWorkerQueue;
  if (!isOrgMigrated(decision)) return baseWorkerQueue;
  return backing ?? baseWorkerQueue;
}
