import { logger } from "~/services/logger.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import type { DeploymentService } from "../deployment.server";
import type { ExternalIdReuseDeployment } from "./resolveExternalIdReuse.server";

export type SupersededDeployment = Pick<ExternalIdReuseDeployment, "version" | "shortCode">;

export function supersededByForceReason(externalId: string): string {
  return `Superseded by a new deploy with --force for external id "${externalId}"`;
}

type CancelSupersededDeploymentsOptions = {
  deploymentService: DeploymentService;
  environmentId: string;
  externalId: string;
  deployments: ExternalIdReuseDeployment[];
};

export async function cancelSupersededDeployments({
  deploymentService,
  environmentId,
  externalId,
  deployments,
}: CancelSupersededDeploymentsOptions): Promise<SupersededDeployment[]> {
  const canceled: SupersededDeployment[] = [];

  for (const deployment of deployments) {
    const result = await deploymentService.cancelDeployment(
      { id: environmentId },
      deployment.friendlyId,
      {
        canceledReason: supersededByForceReason(externalId),
      }
    );

    if (result.isOk()) {
      canceled.push({ version: deployment.version, shortCode: deployment.shortCode });
      continue;
    }

    if (
      result.error.type === "deployment_cannot_be_cancelled" ||
      result.error.type === "deployment_not_found"
    ) {
      logger.debug("Superseded deployment was already final", {
        externalId,
        version: deployment.version,
        reason: result.error.type,
      });
      continue;
    }

    if (result.error.type === "failed_to_delete_deployment_timeout") {
      logger.warn("Failed to dequeue the timeout job for a superseded deployment", {
        externalId,
        version: deployment.version,
        error: result.error.cause,
      });
      canceled.push({ version: deployment.version, shortCode: deployment.shortCode });
      continue;
    }

    throw new ServiceValidationError(
      `Failed to cancel the in-progress deployment ${deployment.version} holding external id "${externalId}". Nothing was built — try again.`,
      500
    );
  }

  return canceled;
}
