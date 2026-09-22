import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { logger } from "~/services/logger.server";
import { makeFlag } from "~/v3/featureFlags.server";

/** Shared activation boundary for the deployment UI, manual deploy and onboarding autosave. */
export async function deploymentOnboardingEnabled(
  organizationId: string,
  client: PrismaClient = prisma
): Promise<boolean> {
  try {
    const organization = await client.organization.findFirst({
      where: { id: organizationId },
      select: { featureFlags: true },
    });
    if (!organization) return false;
    const flags = organization.featureFlags;
    return await makeFlag(client)({
      key: FEATURE_FLAG.deployNowEnabled,
      defaultValue: false,
      overrides: flags && typeof flags === "object" && !Array.isArray(flags) ? flags : undefined,
    });
  } catch (error) {
    logger.warn("Deployment onboarding flag unavailable; using legacy UI", {
      organizationId,
      error,
    });
    return false;
  }
}
