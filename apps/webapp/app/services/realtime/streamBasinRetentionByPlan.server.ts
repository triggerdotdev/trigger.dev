/**
 * Cloud-flavored shim that maps an org's billing plan to its
 * stream-basin state — both whether it should have a dedicated basin
 * at all, and what retention to apply if so.
 *
 * Kept deliberately separate from `streamBasinProvisioner.server.ts`
 * so the provisioner stays purely retention-string-driven and has no
 * coupling to plan vocabulary. This file is the only place in the
 * webapp that maps "plan code" → "basin policy".
 *
 * Operators that don't run a billing API never call this — orgs stay
 * on the global shared basin via the existing read-precedence
 * fallback.
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

/**
 * Plan codes that get a dedicated per-org basin. Free orgs (and
 * unbilled / unknown plan codes) fall through to the shared global
 * basin via the existing read-precedence fallback.
 *
 * Adding a plan: drop its code in here AND in `retentionForPlanCode`.
 */
const PAID_PLAN_CODES = new Set(["v3_hobby_1", "v3_pro_1", "enterprise"]);

export function isPaidPlanCode(code: string | null | undefined): boolean {
  return code != null && PAID_PLAN_CODES.has(code);
}

/**
 * Map a plan code to a retention duration via env-var lookup.
 *
 * Exact-match against a small known set rather than substring matching,
 * since substring matching against future plan codes could grant the
 * wrong tier (e.g. `"approved"` would match `"pro"`). Add a new code
 * here when launching a new plan.
 */
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

/**
 * Reconcile an org's basin state with its current plan. Idempotent;
 * call whenever the plan changes or in a backfill loop.
 *
 * Transitions:
 *
 *   plan paid + no basin    → provision a new basin, stamp column.
 *   plan paid + has basin   → reconfigure retention (tier may have
 *                             changed). S2 retention only applies to
 *                             *new* streams, but that's fine — old
 *                             ones live out their original retention.
 *   plan free + has basin   → null the column. New runs/sessions for
 *                             this org route through the shared global
 *                             basin. The per-org basin lingers until
 *                             its existing streams expire on their
 *                             original retention; no S2-side cleanup
 *                             happens here.
 *   plan free + no basin    → no-op.
 *
 * OSS / non-billing installs always hit the no-op path because
 * `isBillingConfigured()` is false. Free-by-default.
 *
 * Throws on transient billing failure so redis-worker retries —
 * silently defaulting to "free" during an outage would deprovision a
 * paid org's basin and lose isolation.
 */
export async function reconcileBasinForOrg(orgId: string): Promise<ReconcileResult> {
  if (!isBillingConfigured()) {
    return { kind: "skipped", reason: "billing-not-configured" };
  }

  // Feature flag is the master switch for the whole per-org basin
  // pipeline — `provisionBasinForOrg` / `reconfigureBasinForOrg` both
  // no-op when it's off. Bail here so the reconcile log lines and
  // result kinds reflect reality (no "provisioned (paid upgrade)" log
  // for a no-op call), and skip the billing API round-trip entirely.
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
    // Downgrade. Don't touch S2 — basin lingers, old streams keep their
    // original retention until they age out. Just unstamp the org so
    // future runs/sessions flow to the shared global basin.
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
