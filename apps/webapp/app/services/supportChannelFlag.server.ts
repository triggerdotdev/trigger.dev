import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { resolveSupportChannelEnabled } from "~/services/supportChannelFlag";
import { FEATURE_FLAG } from "~/v3/featureFlags";

type SupportChannelFlagPrismaClient = Pick<PrismaClient, "featureFlag" | "organization">;

export async function isSupportChannelEnabled(
  organizationId: string,
  prismaClient: SupportChannelFlagPrismaClient = prisma
): Promise<boolean> {
  const [organization, globalFlags] = await Promise.all([
    prismaClient.organization.findFirst({
      where: { id: organizationId },
      select: { featureFlags: true },
    }),
    prismaClient.featureFlag.findMany({
      where: { key: { in: [FEATURE_FLAG.supportChannelEnabled] } },
      select: { key: true, value: true },
    }),
  ]);

  if (!organization) {
    return false;
  }

  return resolveSupportChannelEnabled(
    Object.fromEntries(globalFlags.map((featureFlag) => [featureFlag.key, featureFlag.value])),
    (organization.featureFlags as Record<string, unknown> | null) ?? undefined
  );
}
