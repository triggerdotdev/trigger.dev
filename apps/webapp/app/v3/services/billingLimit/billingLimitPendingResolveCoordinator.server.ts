import { logger } from "~/services/logger.server";
import { classifyPendingBillingLimitResolveConvergeFailure } from "./billingLimitPendingResolveFailure.server";
import type { PendingBillingLimitResolve } from "./billingLimitPendingResolve.types";

export type RunPendingBillingLimitResolveDeps = {
  converge?: (pending: PendingBillingLimitResolve) => Promise<void>;
  complete?: (organizationId: string) => Promise<{ completed: boolean } | undefined>;
};

export async function runPendingBillingLimitResolves(
  pendingResolves: PendingBillingLimitResolve[],
  deps: RunPendingBillingLimitResolveDeps = {}
): Promise<Set<string>> {
  const converge =
    deps.converge ??
    (await import("./billingLimitConvergeResolve.server")).convergeBillingLimitResolve;
  const complete =
    deps.complete ?? (await import("~/services/platform.v3.server")).completeBillingLimitResolve;

  const stillPendingOrgIds = new Set<string>();

  for (const pending of pendingResolves) {
    try {
      await converge(pending);
    } catch (error) {
      logger.error("Failed to converge pending billing limit resolve", {
        failureClass: classifyPendingBillingLimitResolveConvergeFailure(pending.resumeMode),
        error,
        organizationId: pending.organizationId,
        resumeMode: pending.resumeMode,
        resolvedAt: pending.resolvedAt,
      });
      stillPendingOrgIds.add(pending.organizationId);
      continue;
    }

    try {
      const completion = await complete(pending.organizationId);
      if (!completion || completion.completed !== true) {
        throw new Error("Billing platform client unavailable");
      }
    } catch (error) {
      logger.error("Failed to ack pending billing limit resolve", {
        failureClass: "ack-only",
        error,
        organizationId: pending.organizationId,
        resumeMode: pending.resumeMode,
        resolvedAt: pending.resolvedAt,
      });
      stillPendingOrgIds.add(pending.organizationId);
    }
  }

  return stillPendingOrgIds;
}
