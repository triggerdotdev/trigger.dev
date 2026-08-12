import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";

/**
 * Whether the in-dashboard AI agent is available to this user in this org, per the
 * `hasDashboardAgentAccess` flag with a per-org override winning. Must stay server-side.
 * Both env defaults are off, so an unflagged install has no agent and can start no session.
 */
export async function canAccessDashboardAgent(options: {
  userId: string;
  // Omitted by a caller with no session (a background job, a token-authenticated route),
  // which is read off the user row instead so both answer the preview the same way.
  isAdmin?: boolean;
  isImpersonating: boolean;
  organizationSlug: string;
  // The org's already-loaded `featureFlags`. Omitted means we query the org ourselves.
  orgFeatureFlags?: Record<string, unknown> | null;
}): Promise<boolean> {
  const { userId, isAdmin, isImpersonating, organizationSlug, orgFeatureFlags } = options;

  if (env.DASHBOARD_AGENT_ADMIN_PREVIEW === "1") {
    const admin =
      isAdmin ??
      (await prisma.user.findFirst({ where: { id: userId }, select: { admin: true } }))?.admin;
    if (admin || isImpersonating) return true;
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
