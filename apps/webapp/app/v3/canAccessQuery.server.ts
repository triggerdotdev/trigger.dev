import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { FEATURE_FLAG, makeFlag } from "~/v3/featureFlags.server";

export async function canAccessQuery(options: {
  userId: string;
  isAdmin: boolean;
  isImpersonating: boolean;
  organizationSlug: string;
}): Promise<boolean> {
  const { userId, isAdmin, isImpersonating, organizationSlug } = options;

  // 1. If it's on then we have access
  const globallyEnabled = env.QUERY_FEATURE_ENABLED === "1";
  if (globallyEnabled) {
    return true;
  }

  // 2. Admins always have access
  if (isAdmin || isImpersonating) {
    return true;
  }

  // 3. Check if org/global feature flag is on
  const org = await prisma.organization.findFirst({
    where: {
      slug: organizationSlug,
      members: { some: { userId } },
    },
    select: {
      featureFlags: true,
    },
  });

  const flag = makeFlag();
  const flagResult = await flag({
    key: FEATURE_FLAG.hasQueryAccess,
    defaultValue: false,
    overrides: (org?.featureFlags as Record<string, unknown>) ?? {},
  });
  if (flagResult) {
    return true;
  }

  // 4. Not enabled anywhere
  return false;
}
