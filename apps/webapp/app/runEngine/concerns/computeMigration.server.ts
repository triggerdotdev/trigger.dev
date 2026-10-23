import { hashBucket } from "~/utils/computeBucket";
import type { WorkerQueueEnvironmentOverride } from "~/v3/featureFlags";

/** Subset of the global flags snapshot this resolver reads. */
type ComputeMigrationFlags = {
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
 * Whether this org should run on the compute backing. Precedence: per-org override
 * (both directions) wins; otherwise global enable + the plan's percentage bucket.
 * Enterprise and unknown plans are never enrolled by percentage (override only).
 * Within this decision, the sole opt-out is the per-org `computeMigrationEnabled: false`.
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
      ? (flags?.computeMigrationFreePercentage ?? 0)
      : planType === "paid"
        ? (flags?.computeMigrationPaidPercentage ?? 0)
        : 0; // enterprise / undefined

  return hashBucket(orgId) < pct;
}

type ResolveInput = MigrationDecisionInput & {
  baseWorkerQueue: string | undefined;
  baseEnableFastPath: boolean;
  region: string | undefined; // geo of the base queue (same whether migrated or not)
  backing: { workerQueue: string; enableFastPath: boolean } | undefined;
  envType: string;
  environmentCompat: WorkerQueueEnvironmentOverride["compat"];
  /** Template key of the deployment from the task metadata. Missing means no key. */
  templateKey: string | null | undefined;
};

/**
 * Produce the target descriptor `{ workerQueue, region, enableFastPath }` for a
 * run. When the org is migrated and the region has a compute backing, the queue
 * and fast-path setting come from the MICROVM backing group; `region` is the geo
 * either way. Same-geo swap (us-east-1 -> us-east-1-next): any explicit placement
 * is a geography preference, honored by staying in-region. Applied after region
 * resolution, mirroring the scheduled-split. An environment compat of compute or container
 * decides the swap ahead of the org's migration decision. A deployment without a template key
 * stays on the base queue. The key can only keep a migrated run off compute: templates can exist
 * for orgs that are not migrated, and the dequeue check still covers keyless runs that reach
 * compute.
 */
export function resolveComputeMigration({
  baseWorkerQueue,
  baseEnableFastPath,
  region,
  backing,
  envType,
  environmentCompat,
  templateKey,
  ...decision
}: ResolveInput): {
  workerQueue: string | undefined;
  region: string | undefined;
  enableFastPath: boolean;
  /** Set when the missing template key kept a migrated run on the base queue. */
  templateFallback?: true;
} {
  const passthrough = { workerQueue: baseWorkerQueue, region, enableFastPath: baseEnableFastPath };
  if (baseWorkerQueue === undefined) return passthrough;
  if (envType === "DEVELOPMENT") return passthrough;
  if (!backing) return passthrough;
  const migrated =
    environmentCompat === "compute"
      ? true
      : environmentCompat === "container"
        ? false
        : isOrgMigrated(decision);
  if (!migrated) return passthrough;
  if (!templateKey) return { ...passthrough, templateFallback: true };
  return { workerQueue: backing.workerQueue, region, enableFastPath: backing.enableFastPath };
}
