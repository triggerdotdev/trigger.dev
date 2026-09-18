import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { BranchTrackingConfigSchema, getTrackedBranchForEnvironment } from "~/v3/github";
import { deploymentOnboardingEnabled } from "./deploymentOnboardingEnabled.server";
import { atomicProductionDeploymentUrl } from "./atomicProductionDeployment.server";

/** Keep the existing marketplace deployment payload until branch selection is enabled. */
export async function marketplaceInitialDeploymentOptions(
  projectId: string,
  organizationId: string,
  client: PrismaClient = prisma
): Promise<{ environment: "prod"; branch?: string }> {
  let enabled: boolean;
  try {
    enabled = await deploymentOnboardingEnabled(organizationId, client);
  } catch (error) {
    // A flag lookup outage must not stop the existing marketplace deployment flow.
    logger.warn("Could not resolve marketplace deployment flag; using legacy deployment", {
      projectId,
      error,
    });
    return { environment: "prod" };
  }
  if (!enabled) return { environment: "prod" };

  // Marketplace onboarding is an existing Vercel-driven flow, not a manual release.
  // Keep its legacy request rather than opt it into the unsupported branch path.
  if (await atomicProductionDeploymentUrl(projectId, "PRODUCTION", client)) {
    return { environment: "prod" };
  }

  const connectedRepo = await client.connectedGithubRepository.findFirst({
    where: { projectId, project: { organizationId } },
    select: {
      branchTracking: true,
      repository: { select: { defaultBranch: true } },
    },
  });
  const branchTracking = connectedRepo
    ? BranchTrackingConfigSchema.safeParse(connectedRepo.branchTracking)
    : undefined;
  const branch =
    (branchTracking?.success
      ? getTrackedBranchForEnvironment(branchTracking.data, false, { type: "PRODUCTION" })
      : undefined) ?? connectedRepo?.repository.defaultBranch;

  return { environment: "prod", branch };
}
