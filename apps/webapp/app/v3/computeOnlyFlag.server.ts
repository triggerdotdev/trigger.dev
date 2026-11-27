import type { DeploymentAccessDecision } from "@trigger.dev/plugins";
import type { PrismaClientOrTransaction } from "~/db.server";
import { logger } from "~/services/logger.server";
import { FEATURE_FLAG, isPlainFlagObject } from "~/v3/featureFlags";

/** Whether the org's deployed runs must execute only on compute lanes. Runs on every trigger. */
export function computeOnlyEnabled(orgFeatureFlags: unknown): boolean {
  return isPlainFlagObject(orgFeatureFlags) && orgFeatureFlags[FEATURE_FLAG.computeOnly] === true;
}

/**
 * The org's `featureFlags`, read by primary key from `client`. Finalize passes the primary: the
 * initialize call just before it may have set `computeOnly`, and a replica can still miss that.
 */
export async function loadOrgFeatureFlags(
  client: PrismaClientOrTransaction,
  organizationId: string
): Promise<unknown> {
  const organization = await client.organization.findFirst({
    where: { id: organizationId },
    select: { featureFlags: true },
  });
  return organization?.featureFlags ?? null;
}

/**
 * Mirrors an allowed deploy's placement into the org's `computeOnly` flag, so the trigger path can
 * read it from flags it already loads. Sets it for a compute-only placement and removes it
 * otherwise. `currentFlags` is the org's `featureFlags` as the caller loaded them (undefined when
 * it didn't), usually from a replica: when a plain placement finds no flag there, no statement is
 * sent, so a plain deploy costs nothing. A compute-only placement always sends its statement,
 * because a stale read that still shows the flag must never leave the org without it. The
 * conditional `WHERE` keeps that statement from rewriting a row that already has the flag. A
 * statement that changed the row logs `computeOnly set` or `computeOnly cleared` with `context`.
 */
export async function syncComputeOnlyFlag(
  client: PrismaClientOrTransaction,
  organizationId: string,
  decision: Extract<DeploymentAccessDecision, { allowed: true }>,
  currentFlags?: unknown,
  context: Record<string, string | undefined> = {}
): Promise<void> {
  const wanted = decision.placement === "microvm";
  if (!wanted && currentFlags !== undefined && !computeOnlyEnabled(currentFlags)) return;
  const changed = wanted
    ? await client.$executeRaw`
      UPDATE "Organization"
      SET "featureFlags" = jsonb_set(COALESCE("featureFlags", '{}'::jsonb), '{computeOnly}', 'true'::jsonb)
      WHERE id = ${organizationId}
        AND ("featureFlags" IS NULL OR "featureFlags"->'computeOnly' IS DISTINCT FROM 'true'::jsonb)`
    : await client.$executeRaw`
      UPDATE "Organization"
      SET "featureFlags" = "featureFlags" - 'computeOnly'
      WHERE id = ${organizationId} AND "featureFlags" ? 'computeOnly'`;
  if (changed > 0) {
    logger.info(wanted ? "computeOnly set" : "computeOnly cleared", { organizationId, ...context });
  }
}
