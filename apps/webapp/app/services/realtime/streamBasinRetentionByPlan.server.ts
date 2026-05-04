/**
 * Cloud-flavored shim that resolves a stream-basin retention duration
 * from an org's current billing plan.
 *
 * Kept deliberately separate from `streamBasinProvisioner.server.ts`
 * so the provisioner stays purely retention-string-driven and has no
 * coupling to plan vocabulary. This file is the only place in the
 * webapp that maps "plan code" → "retention duration".
 *
 * Operators that don't run a billing API just don't call this — the
 * provisioner accepts retention strings directly, and the org-create
 * path falls back to `defaultRetention()`.
 */
import { env } from "~/env.server";
import { getCurrentPlan, isBillingConfigured } from "~/services/platform.v3.server";
import { defaultRetention } from "./streamBasinProvisioner.server";

/**
 * Resolve the retention duration for an org based on its current plan.
 *
 *  - When billing is **not configured** (OSS / self-hosted installs),
 *    returns `defaultRetention()` — the worker job converges, the
 *    backfill completes, and operators get a sane default without
 *    having to wire up a billing API.
 *  - When billing **is configured** and the call succeeds, maps the
 *    plan code to a retention duration.
 *  - When billing **is configured** but the call failed (transient
 *    outage / 5xx), **throws** so the redis-worker retry kicks in
 *    and we don't silently downgrade a paid org's retention.
 */
export async function resolveRetentionForOrg(orgId: string): Promise<string> {
  if (!isBillingConfigured()) {
    // No billing wired up — operator either runs OSS or hasn't set
    // BILLING_API_URL / BILLING_API_KEY. Fall back to the default;
    // the org-create path uses the same default, so this is just the
    // backfill's catch-up path arriving at the same answer.
    return defaultRetention();
  }

  const plan = await getCurrentPlan(orgId);
  if (plan === undefined) {
    // Billing client exists but the call failed. Throw so redis-worker
    // retries — silently defaulting to free would clip a paid org's
    // retention if a backfill landed during a transient billing outage.
    throw new Error(
      `[streamBasinRetentionByPlan] billing plan unavailable for org ${orgId}; will retry`
    );
  }

  return retentionForPlanCode(plan.v3Subscription?.plan?.code);
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
