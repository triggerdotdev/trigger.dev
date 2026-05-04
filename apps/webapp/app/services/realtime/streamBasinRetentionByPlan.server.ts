/**
 * Plan → basin policy. The only place that knows which plan codes
 * earn a dedicated basin and what retention each gets. Operators
 * without a billing API never reach this — orgs stay on the shared
 * basin via the read-precedence fallback.
 */
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { getCurrentPlan, isBillingConfigured } from "~/services/platform.v3.server";
import {
  defaultRetention,
  isPerOrgBasinsEnabled,
  provisionBasinForOrg,
  reconfigureBasinForOrg,
} from "./streamBasinProvisioner.server";

// Adding a plan: drop its code here AND in `retentionForPlanCode`.
// Exact-match against a known set; substring matching could grant the
// wrong tier (e.g. `"approved"` would match `"pro"`).
const PAID_PLAN_CODES = new Set(["v3_hobby_1", "v3_pro_1", "enterprise"]);

export function isPaidPlanCode(code: string | null | undefined): boolean {
  return code != null && PAID_PLAN_CODES.has(code);
}

export function retentionForPlanCode(code: string | null | undefined): string {
  if (!code) return defaultRetention();

  switch (code) {
    case "free":
      return env.REALTIME_STREAMS_BASIN_RETENTION_FREE;
    case "v3_hobby_1":
      return env.REALTIME_STREAMS_BASIN_RETENTION_HOBBY;
    case "v3_pro_1":
    case "enterprise":
      return env.REALTIME_STREAMS_BASIN_RETENTION_PRO;
    default:
      return defaultRetention();
  }
}

type ReconcileResult =
  | {
      kind: "skipped";
      reason:
        | "billing-not-configured"
        | "feature-disabled"
        | "org-not-found"
        | "free-no-basin";
    }
  | { kind: "provisioned"; retention: string }
  | { kind: "reconfigured"; retention: string }
  | { kind: "deprovisioned" };

// Reconcile an org's basin state with its current plan. Idempotent.
//
// paid + no basin    → provision, stamp column.
// paid + has basin   → reconfigure retention (in case the tier changed).
// free + has basin   → null the column; basin lingers until its streams
//                      age out on their original retention.
// free + no basin    → no-op.
//
// Throws on transient billing failure so redis-worker retries —
// silently defaulting to "free" during an outage would deprovision a
// paid org's basin.
export async function reconcileBasinForOrg(orgId: string): Promise<ReconcileResult> {
  if (!isBillingConfigured()) {
    return { kind: "skipped", reason: "billing-not-configured" };
  }

  // Provisioner / reconfigure both no-op when the flag is off. Bail
  // here so logs and result kinds reflect that, and skip the billing
  // round-trip we couldn't act on anyway.
  if (!isPerOrgBasinsEnabled()) {
    return { kind: "skipped", reason: "feature-disabled" };
  }

  const plan = await getCurrentPlan(orgId);
  if (plan === undefined) {
    throw new Error(
      `[streamBasinReconciler] billing plan unavailable for org ${orgId}; will retry`
    );
  }

  const planCode = plan.v3Subscription?.plan?.code;
  const paid = isPaidPlanCode(planCode);

  const org = await prisma.organization.findFirst({
    where: { id: orgId },
    select: { id: true, streamBasinName: true },
  });
  if (!org) {
    return { kind: "skipped", reason: "org-not-found" };
  }

  if (paid && !org.streamBasinName) {
    const retention = retentionForPlanCode(planCode);
    await provisionBasinForOrg({ id: org.id, streamBasinName: null, retention });
    logger.info("[streamBasinReconciler] provisioned (paid upgrade)", {
      orgId,
      planCode,
      retention,
    });
    return { kind: "provisioned", retention };
  }

  if (paid && org.streamBasinName) {
    const retention = retentionForPlanCode(planCode);
    await reconfigureBasinForOrg(org.id, retention);
    logger.info("[streamBasinReconciler] reconfigured (paid tier change)", {
      orgId,
      planCode,
      retention,
    });
    return { kind: "reconfigured", retention };
  }

  if (!paid && org.streamBasinName) {
    // Downgrade: unstamp the org so future runs/sessions land in the
    // shared basin. Don't touch S2 — old streams age out on their own.
    await prisma.organization.update({
      where: { id: org.id },
      data: { streamBasinName: null },
    });
    logger.info("[streamBasinReconciler] deprovisioned (downgrade to free)", {
      orgId,
      planCode,
      previousBasin: org.streamBasinName,
    });
    return { kind: "deprovisioned" };
  }

  return { kind: "skipped", reason: "free-no-basin" };
}
