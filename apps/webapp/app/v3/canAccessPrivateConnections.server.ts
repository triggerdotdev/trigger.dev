import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";

export async function canAccessPrivateConnections(options: {
  organizationSlug: string;
  userId: string;
}): Promise<boolean> {
  const { organizationSlug, userId } = options;

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
  return flag({
    key: FEATURE_FLAG.hasPrivateConnections,
    defaultValue: env.PRIVATE_CONNECTIONS_ENABLED === "1",
    overrides: (org?.featureFlags as Record<string, unknown>) ?? {},
  });
}
