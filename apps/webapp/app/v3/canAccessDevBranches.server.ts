import { prisma } from "~/db.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";

export async function canAccessDevBranches(organizationId: string): Promise<boolean> {
  const org = await prisma.organization.findFirst({
    where: { id: organizationId },
    select: { featureFlags: true },
  });

  const flag = makeFlag();
  return flag({
    key: FEATURE_FLAG.devBranchesEnabled,
    defaultValue: false,
    overrides: (org?.featureFlags as Record<string, unknown>) ?? {},
  });
}
