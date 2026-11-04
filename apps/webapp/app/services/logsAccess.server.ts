import { prisma } from "~/db.server";
import { resolveOrganizationFeatureFlags } from "~/v3/featureFlags.server";

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

  if (!organization) {
    return false;
  }

  const flags = await resolveOrganizationFeatureFlags(organization.featureFlags);
  return flags.hasLogsPageAccess === true;
}
