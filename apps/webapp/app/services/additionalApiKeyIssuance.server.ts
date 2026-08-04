import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { resolveAdditionalApiKeyIssuance } from "~/services/additionalApiKeyIssuance";
import { FEATURE_FLAG } from "~/v3/featureFlags";

type IssuancePrismaClient = Pick<PrismaClient, "featureFlag" | "organization">;

export async function canIssueAdditionalApiKeys(
  organizationId: string,
  prismaClient: IssuancePrismaClient = prisma
): Promise<boolean> {
  const [organization, globalFlags] = await Promise.all([
    prismaClient.organization.findFirst({
      where: { id: organizationId },
      select: { featureFlags: true },
    }),
    prismaClient.featureFlag.findMany({
      where: {
        key: {
          in: [FEATURE_FLAG.additionalApiKeysEnabled, FEATURE_FLAG.additionalApiKeyIssuanceEnabled],
        },
      },
      select: { key: true, value: true },
    }),
  ]);

  if (!organization) {
    return false;
  }

  return resolveAdditionalApiKeyIssuance(
    Object.fromEntries(globalFlags.map((featureFlag) => [featureFlag.key, featureFlag.value])),
    (organization.featureFlags as Record<string, unknown> | null) ?? undefined
  );
}
