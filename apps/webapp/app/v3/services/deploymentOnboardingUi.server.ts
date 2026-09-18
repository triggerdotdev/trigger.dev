import { type PrismaClient, type RuntimeEnvironmentType } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { DeploymentPresenter } from "~/presenters/v3/DeploymentPresenter.server";
import { isBillingConfigured } from "~/services/platform.v3.server";
import { rbac } from "~/services/rbac.server";
import { checkPermissions } from "~/services/routeBuilders/permissions.server";
import { shouldSelectDeploymentOnboarding } from "~/utils/deploymentOnboarding";
import { atomicProductionDeploymentUrl } from "./atomicProductionDeployment.server";
import { findOnboardingDeployment } from "./deploymentOnboarding.server";
import { deploymentOnboardingEnabled } from "./deploymentOnboardingEnabled.server";

/**
 * Shared resolution of the GitHub first-deployment onboarding, so the deployments list and the
 * tasks empty state render the identical flow on deployable environments. Callers supply the
 * connected repo / tracked branch. Development keeps its own copy and is not selected here.
 */
export async function resolveDeploymentOnboardingUi({
  request,
  userId,
  organizationSlug,
  projectSlug,
  environmentSlug,
  organizationId,
  projectId,
  environmentId,
  environmentType,
  url,
  deploymentParam,
  client = prisma,
}: {
  request: Request;
  userId: string;
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  environmentType: RuntimeEnvironmentType;
  url: URL;
  deploymentParam?: string;
  client?: PrismaClient;
}) {
  // Resolve activation before project auth, first-build reads or platform setup.
  const deployNowEnabled = await deploymentOnboardingEnabled(organizationId, client);
  const inactive = {
    canDeployNow: false,
    deployNowEnabled,
    isPlatformConfigured: false,
    showGitHubOnboarding: false,
    onboardingDetails: undefined,
    atomicVercelUrl: undefined,
  };
  if (!deployNowEnabled || environmentType === "DEVELOPMENT") return inactive;

  const deploymentAuth = await rbac.authenticateSession(request, {
    userId,
    organizationId,
    projectId,
  });
  const canDeployNow = deploymentAuth.ok
    ? checkPermissions(deploymentAuth.ability, {
        canWriteDeployments: { action: "write", resource: { type: "deployments" } },
      }).canWriteDeployments
    : false;
  const isPlatformConfigured = isBillingConfigured();

  const selection = shouldSelectDeploymentOnboarding({
    enabled: deployNowEnabled,
    platformConfigured: isPlatformConfigured,
    allowUnconfiguredPlatform: env.NODE_ENV === "development",
    environmentType,
    url,
    deploymentParam,
  })
    ? await findOnboardingDeployment(client, environmentId)
    : { eligible: false as const };
  const onboardingDetails =
    selection.eligible && selection.shortCode
      ? await new DeploymentPresenter().call({
          userId,
          organizationSlug,
          projectSlug,
          environmentSlug,
          deploymentShortCode: selection.shortCode,
        })
      : undefined;
  const showGitHubOnboarding =
    selection.eligible && onboardingDetails?.deployment.status !== "DEPLOYED";

  const atomicVercelUrl = deployNowEnabled
    ? await atomicProductionDeploymentUrl(projectId, environmentType, client)
    : undefined;

  return {
    canDeployNow,
    deployNowEnabled,
    isPlatformConfigured,
    showGitHubOnboarding,
    onboardingDetails: showGitHubOnboarding ? onboardingDetails : undefined,
    atomicVercelUrl,
  };
}
