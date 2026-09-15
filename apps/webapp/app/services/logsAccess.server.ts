import { prisma } from "~/db.server";
import { FEATURE_FLAG, validateFeatureFlagValue } from "~/v3/featureFlags";

export async function hasLogsPageAccess(
  userId: string,
  isAdmin: boolean,
  isImpersonating: boolean,
  organizationSlug: string
): Promise<boolean> {
  if (isAdmin || isImpersonating) {
    return true;
  }

  const organization = await prisma.organization.findFirst({
    where: {
      slug: organizationSlug,
      members: { some: { userId } },
    },
    select: { featureFlags: true },
  });

  if (!organization?.featureFlags) {
    return false;
  }

  const flags = organization.featureFlags as Record<string, unknown>;
  const result = validateFeatureFlagValue(FEATURE_FLAG.hasLogsPageAccess, flags.hasLogsPageAccess);
  return result.success && result.data === true;
}
