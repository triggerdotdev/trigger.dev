import { type Prisma, type WorkloadType } from "@trigger.dev/database";
import { type PrismaClientOrTransaction } from "~/db.server";
import { FEATURE_FLAG } from "./featureFlags";
import { makeFlag } from "./featureFlags.server";

/**
 * Resolves whether an org has compute access based on feature flags.
 */
export async function resolveComputeAccess(
  prisma: PrismaClientOrTransaction,
  orgFeatureFlags: unknown
): Promise<boolean> {
  const flag = makeFlag(prisma);
  return flag({
    key: FEATURE_FLAG.hasComputeAccess,
    defaultValue: false,
    overrides: (orgFeatureFlags as Record<string, unknown>) ?? {},
  });
}

/**
 * Builds a visibility filter for non-admin, non-allowlisted users.
 * Without compute access, MICROVM regions are excluded entirely.
 * With compute access, hidden flag works normally (existing behavior).
 */
export function defaultVisibilityFilter(
  hasComputeAccess: boolean
): Prisma.WorkerInstanceGroupWhereInput {
  if (hasComputeAccess) {
    return { hidden: false };
  }

  return { hidden: false, workloadType: { not: "MICROVM" } };
}

/**
 * Canonical fallback chain for a run's default region:
 * environment default -> project default -> global default.
 * Both the trigger path and the regions UI must use this order so the
 * displayed default matches what actually runs.
 */
export function resolveEffectiveDefaultWorkerGroupId({
  environmentDefaultWorkerGroupId,
  projectDefaultWorkerGroupId,
  globalDefaultWorkerGroupId,
}: {
  environmentDefaultWorkerGroupId?: string | null;
  projectDefaultWorkerGroupId?: string | null;
  globalDefaultWorkerGroupId?: string | null;
}): string | undefined {
  return (
    environmentDefaultWorkerGroupId ??
    projectDefaultWorkerGroupId ??
    globalDefaultWorkerGroupId ??
    undefined
  );
}

/**
 * Whether a region is accessible given compute access.
 * MICROVM regions require compute access; all other types pass through.
 */
export function isComputeRegionAccessible(
  region: { workloadType: WorkloadType },
  hasComputeAccess: boolean
): boolean {
  if (region.workloadType !== "MICROVM") {
    return true;
  }

  // Allow access to any MICROVM region if the org has compute access
  return hasComputeAccess;
}
