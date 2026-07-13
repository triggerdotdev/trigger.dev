import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";

/**
 * Whether the in-dashboard AI agent is available to this user in this org.
 * Gated by the global / per-org `hasDashboardAgentAccess` flag, with
 * `DASHBOARD_AGENT_ENABLED` as the global default (a per-org override wins).
 * Admins/impersonators bypass it only when `DASHBOARD_AGENT_ADMIN_PREVIEW` is on
 * (default off). Enforced server-side so a non-flagged user can't start sessions.
 */
export async function canAccessDashboardAgent(options: {
  userId: string;
  isAdmin: boolean;
  isImpersonating: boolean;
  organizationSlug: string;
  // When the caller already has the org's `featureFlags` loaded (e.g. a layout
  // loader that queried the org with a membership check), pass them to skip the
  // extra org lookup. Omit it and we query the org ourselves.
  orgFeatureFlags?: Record<string, unknown> | null;
}): Promise<boolean> {
  const { userId, isAdmin, isImpersonating, organizationSlug, orgFeatureFlags } = options;

  if ((isAdmin || isImpersonating) && env.DASHBOARD_AGENT_ADMIN_PREVIEW === "1") {
    return true;
  }

  let overrides = orgFeatureFlags;
  if (overrides === undefined) {
    const org = await prisma.organization.findFirst({
      where: {
        slug: organizationSlug,
        members: { some: { userId } },
      },
      select: {
        featureFlags: true,
      },
    });
    overrides = (org?.featureFlags as Record<string, unknown>) ?? {};
  }

  const flag = makeFlag();
  const flagResult = await flag({
    key: FEATURE_FLAG.hasDashboardAgentAccess,
    defaultValue: env.DASHBOARD_AGENT_ENABLED === "1",
    overrides: overrides ?? {},
  });

  return Boolean(flagResult);
}
