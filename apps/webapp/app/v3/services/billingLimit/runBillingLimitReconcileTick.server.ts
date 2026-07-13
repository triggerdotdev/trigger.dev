import type { BillingLimitsPendingResolvesResult } from "~/services/billingLimit.schemas";
import { logger } from "~/services/logger.server";
import { runPendingBillingLimitResolves } from "./billingLimitPendingResolveCoordinator.server";
import type { PendingBillingLimitResolve } from "./billingLimitPendingResolve.types";
import type { OrgReconcileTarget } from "./billingLimitReconciliation.server";
import type { reconcileBillingLimitTarget } from "./billingLimitReconcileTarget.server";

export type RunBillingLimitReconcileTickDeps = {
  getPendingResolves?: () => Promise<BillingLimitsPendingResolvesResult | undefined>;
  runPendingResolves?: (pendingResolves: PendingBillingLimitResolve[]) => Promise<Set<string>>;
  collectOrgs?: (options?: { excludeOrgIds?: Set<string> }) => Promise<{
    targets: OrgReconcileTarget[];
    queuedOrgIds: string[];
  }>;
  reconcileTarget?: typeof reconcileBillingLimitTarget;
  clearProcessedQueue?: (queuedOrgIds: string[], processedOrgIds: string[]) => Promise<void>;
  bustCaches?: (organizationId: string) => void;
  enqueueConverge?: (
    organizationId: string,
    targetState: OrgReconcileTarget["targetState"]
  ) => Promise<void>;
};

export async function runBillingLimitReconcileTick(
  deps: RunBillingLimitReconcileTickDeps = {}
): Promise<void> {
  const getPendingResolves =
    deps.getPendingResolves ??
    (await import("~/services/platform.v3.server")).getPendingBillingLimitResolves;
  const runPendingResolves = deps.runPendingResolves ?? runPendingBillingLimitResolves;
  const collectOrgs =
    deps.collectOrgs ??
    (await import("./billingLimitReconciliation.server")).collectOrgsToReconcile;
  const reconcileTarget =
    deps.reconcileTarget ??
    (await import("./billingLimitReconcileTarget.server")).reconcileBillingLimitTarget;
  const clearProcessedQueue =
    deps.clearProcessedQueue ??
    (await import("./billingLimitReconciliation.server")).clearProcessedReconcileQueueEntries;
  const bustCaches =
    deps.bustCaches ?? (await import("~/services/platform.v3.server")).bustBillingLimitCaches;

  const pendingResolves = (await getPendingResolves())?.orgs ?? [];
  const stillPendingOrgIds = await runPendingResolves(pendingResolves);

  const { targets, queuedOrgIds } = await collectOrgs({
    excludeOrgIds: stillPendingOrgIds,
  });

  const enqueueConverge =
    deps.enqueueConverge ??
    (async (organizationId, targetState) => {
      const { enqueueBillingLimitConverge } = await import("~/v3/billingLimitWorker.server");
      await enqueueBillingLimitConverge(organizationId, targetState);
    });

  const processedOrgIds: string[] = [];
  for (const target of targets) {
    try {
      await reconcileTarget(target, {
        bustCaches,
        enqueueConverge,
      });
      processedOrgIds.push(target.organizationId);
    } catch (error) {
      logger.error("Failed to reconcile billing limit target", {
        organizationId: target.organizationId,
        targetState: target.targetState,
        error,
      });
    }
  }

  await clearProcessedQueue(queuedOrgIds, processedOrgIds);
}
