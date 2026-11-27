import type { Limits } from "@trigger.dev/platform";

export type AuditLogVisibility = { days: number } | "unlimited" | "unknown";

/** The part of billing's current-plan response this reads. */
type CurrentPlanRead =
  | {
      success: true;
      v3Subscription?: { plan?: { limits?: Pick<Limits, "auditLogVisibilityDays"> } };
    }
  | { success: false };

/** A namespace of `createCache`, as the platform cache builds one. */
type DaysCache = {
  swr(
    key: string,
    load: (key: string) => Promise<number | undefined>
  ): Promise<{ val?: number; err?: unknown }>;
};

export type AuditLogVisibilityOptions = {
  /** Billing's current-plan call, or undefined without billing (self-hosted). */
  currentPlan: ((organizationId: string) => Promise<CurrentPlanRead>) | undefined;
  cache: DaysCache;
  onFailure?: (kind: "caught" | "no_success") => void;
};

/**
 * How many days of audit log history an org's plan shows. A plan without the limit shows none.
 *
 * `unknown` means billing was configured but unreadable. Self-hosted deployments have no billing
 * service, so nothing limits them: `unlimited`. Failures are kept out of the cache for the same
 * reason as `getSsoEntitlement`.
 */
export async function readAuditLogVisibility(
  organizationId: string,
  { currentPlan, cache, onFailure }: AuditLogVisibilityOptions
): Promise<AuditLogVisibility> {
  if (!currentPlan) return "unlimited";

  try {
    const result = await cache.swr(organizationId, async () => {
      try {
        const response = await currentPlan(organizationId);
        if (!response.success) {
          onFailure?.("no_success");
          return undefined;
        }
        return response.v3Subscription?.plan?.limits?.auditLogVisibilityDays?.number ?? 0;
      } catch (_e) {
        onFailure?.("caught");
        return undefined;
      }
    });

    if (result.err || result.val === undefined) return "unknown";

    return { days: result.val };
  } catch (_e) {
    onFailure?.("caught");
    return "unknown";
  }
}
