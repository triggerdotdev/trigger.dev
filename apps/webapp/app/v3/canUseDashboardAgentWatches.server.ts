import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";

/**
 * Whether the agent may offer watches in this org, per the `dashboardAgentWatchEnabled`
 * flag with a per-org override winning. Both env defaults are off, so an unflagged install
 * has no watch tools, no watch guidance and no watch UI. Must stay server-side.
 */
export async function canUseDashboardAgentWatches(options: {
  userId: string;
  organizationSlug: string;
  // The org's already-loaded `featureFlags`. Omitted means we query the org ourselves.
  orgFeatureFlags?: Record<string, unknown> | null;
}): Promise<boolean> {
  const { userId, organizationSlug, orgFeatureFlags } = options;

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
    key: FEATURE_FLAG.dashboardAgentWatchEnabled,
    defaultValue: env.DASHBOARD_AGENT_WATCH_ENABLED === "1",
    overrides: overrides ?? {},
  });

  return Boolean(flagResult);
}
