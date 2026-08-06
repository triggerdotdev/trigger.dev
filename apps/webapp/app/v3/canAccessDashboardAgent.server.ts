import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";

/**
 * Whether the in-dashboard AI agent is available to this user in this org, per the
 * `hasDashboardAgentAccess` flag with a per-org override winning. Must stay server-side.
 */
export async function canAccessDashboardAgent(options: {
  userId: string;
  isAdmin: boolean;
  isImpersonating: boolean;
  organizationSlug: string;
  // The org's already-loaded `featureFlags`. Omitted means we query the org ourselves.
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
