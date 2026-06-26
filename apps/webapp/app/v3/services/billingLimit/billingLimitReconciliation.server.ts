import { EnvironmentPauseSource } from "@trigger.dev/database";
import pMap from "p-map";
import { prisma } from "~/db.server";
import type { BillingLimitResult } from "~/services/billingLimit.schemas";
import { logger } from "~/services/logger.server";
import { getActiveBillingLimits, getBillingLimit } from "~/services/platform.v3.server";
import {
  BILLING_LIMIT_RECONCILE_LOOKUP_CONCURRENCY,
  type BillingLimitConvergeTargetState,
} from "./billingLimitConstants";
import {
  readBillingLimitReconcileQueue,
  removeFromBillingLimitReconcileQueue,
} from "./billingLimitReconcileQueue.server";

export type OrgReconcileTarget = {
  organizationId: string;
  targetState: BillingLimitConvergeTargetState;
};

export function resolveConvergeTargetFromBillingLimit(
  billingLimit: BillingLimitResult | undefined
): BillingLimitConvergeTargetState {
  if (!billingLimit?.isConfigured) {
    return "ok";
  }

  if (billingLimit.limitState.status === "grace") {
    return "grace";
  }

  if (billingLimit.limitState.status === "rejected") {
    return "rejected";
  }

  return "ok";
}

/** Reconcile path only — skip org when the platform lookup failed (undefined ≠ unconfigured). */
export function resolveReconcileTargetFromBillingLimit(
  billingLimit: BillingLimitResult | undefined
): BillingLimitConvergeTargetState | undefined {
  if (billingLimit === undefined) {
    return undefined;
  }

  return resolveConvergeTargetFromBillingLimit(billingLimit);
}

export async function getOrgIdsWithBillingPauseSource(): Promise<string[]> {
  const rows = await prisma.runtimeEnvironment.findMany({
    where: {
      pauseSource: EnvironmentPauseSource.BILLING_LIMIT,
    },
    select: {
      organizationId: true,
    },
    distinct: ["organizationId"],
  });

  return rows.map((row) => row.organizationId);
}

export function collectOrgIdsNeedingBillingLimitLookup(options: {
  staleOrgIds: string[];
  queuedOrgIds: string[];
  excludeOrgIds: Set<string>;
  coveredOrgIds: Set<string>;
}): string[] {
  const orgIds = new Set<string>();

  for (const organizationId of [...options.staleOrgIds, ...options.queuedOrgIds]) {
    if (options.excludeOrgIds.has(organizationId) || options.coveredOrgIds.has(organizationId)) {
      continue;
    }

    orgIds.add(organizationId);
  }

  return [...orgIds];
}

export async function resolveReconcileTargetsForOrgLookups(
  organizationIds: string[],
  options?: {
    getBillingLimit?: (organizationId: string) => Promise<BillingLimitResult | undefined>;
    concurrency?: number;
  }
): Promise<Map<string, BillingLimitConvergeTargetState>> {
  const lookupBillingLimit = options?.getBillingLimit ?? getBillingLimit;
  const concurrency = options?.concurrency ?? BILLING_LIMIT_RECONCILE_LOOKUP_CONCURRENCY;
  const targets = new Map<string, BillingLimitConvergeTargetState>();

  await pMap(
    organizationIds,
    async (organizationId) => {
      try {
        const billingLimit = await lookupBillingLimit(organizationId);
        const targetState = resolveReconcileTargetFromBillingLimit(billingLimit);
        if (targetState === undefined) {
          logger.warn("Skipping billing limit reconcile — platform lookup unavailable", {
            organizationId,
          });
          return;
        }

        targets.set(organizationId, targetState);
      } catch (error) {
        logger.error("Failed billing limit lookup for reconcile", {
          organizationId,
          error,
        });
      }
    },
    { concurrency }
  );

  return targets;
}

export async function collectOrgsToReconcile(options?: { excludeOrgIds?: Set<string> }): Promise<{
  targets: OrgReconcileTarget[];
  queuedOrgIds: string[];
}> {
  const excludeOrgIds = options?.excludeOrgIds ?? new Set<string>();
  const targetByOrgId = new Map<string, BillingLimitConvergeTargetState>();

  const activeLimits = await getActiveBillingLimits();
  if (activeLimits) {
    for (const org of activeLimits.orgs) {
      if (excludeOrgIds.has(org.orgId)) {
        continue;
      }
      targetByOrgId.set(org.orgId, org.limitState);
    }
  }

  const [staleOrgIds, queuedOrgIds] = await Promise.all([
    getOrgIdsWithBillingPauseSource(),
    readBillingLimitReconcileQueue(),
  ]);

  const orgIdsNeedingLookup = collectOrgIdsNeedingBillingLimitLookup({
    staleOrgIds,
    queuedOrgIds,
    excludeOrgIds,
    coveredOrgIds: new Set(targetByOrgId.keys()),
  });

  const lookedUpTargets = await resolveReconcileTargetsForOrgLookups(orgIdsNeedingLookup);
  for (const [organizationId, targetState] of lookedUpTargets) {
    targetByOrgId.set(organizationId, targetState);
  }

  return {
    targets: Array.from(targetByOrgId.entries()).map(([organizationId, targetState]) => ({
      organizationId,
      targetState,
    })),
    queuedOrgIds,
  };
}

export async function clearProcessedReconcileQueueEntries(
  queuedOrgIds: string[],
  processedOrgIds: string[]
): Promise<void> {
  const processed = new Set(processedOrgIds);
  const toRemove = queuedOrgIds.filter((orgId) => processed.has(orgId));
  await removeFromBillingLimitReconcileQueue(toRemove);
}
