import { WorkerDeployment } from "@trigger.dev/database";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { ExecuteTasksWaitingForDeployService } from "./executeTasksWaitingForDeploy";
import { compareDeploymentVersions } from "../utils/deploymentVersions";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";

export type ChangeCurrentDeploymentDirection = "promote" | "rollback";

export class ChangeCurrentDeploymentService extends BaseService {
  public async call(deployment: WorkerDeployment, direction: ChangeCurrentDeploymentDirection) {
    if (!deployment.workerId) {
      throw new ServiceValidationError(
        direction === "promote"
          ? "Deployment is not associated with a worker and cannot be promoted."
          : "Deployment is not associated with a worker and cannot be rolled back."
      );
    }

    if (deployment.status !== "DEPLOYED") {
      throw new ServiceValidationError(
        direction === "promote"
          ? "Deployment must be in the DEPLOYED state to be promoted."
          : "Deployment must be in the DEPLOYED state to be rolled back."
      );
    }

    const currentPromotion = await this._prisma.workerDeploymentPromotion.findFirst({
      where: {
        environmentId: deployment.environmentId,
        label: CURRENT_DEPLOYMENT_LABEL,
      },
      select: {
        deployment: {
          select: { id: true, version: true },
        },
      },
    });

    if (currentPromotion) {
      if (currentPromotion.deployment.id === deployment.id) {
        throw new ServiceValidationError("Deployment is already the current deployment.");
      }

      // if there is a current promotion, we have to validate we are moving in the right direction based on the deployment versions
      switch (direction) {
        case "promote": {
          if (
            compareDeploymentVersions(currentPromotion.deployment.version, deployment.version) >= 0
          ) {
            throw new ServiceValidationError(
              "Cannot promote a deployment that is older than the current deployment."
            );
          }
          break;
        }
        case "rollback": {
          if (
            compareDeploymentVersions(currentPromotion.deployment.version, deployment.version) <= 0
          ) {
            throw new ServiceValidationError(
              "Cannot rollback to a deployment that is newer than the current deployment."
            );
          }
          break;
        }
      }
    }

    //set this deployment as the current deployment for this environment
    await this._prisma.workerDeploymentPromotion.upsert({
      where: {
        environmentId_label: {
          environmentId: deployment.environmentId,
          label: CURRENT_DEPLOYMENT_LABEL,
        },
      },
      create: {
        deploymentId: deployment.id,
        environmentId: deployment.environmentId,
        label: CURRENT_DEPLOYMENT_LABEL,
      },
      update: {
        deploymentId: deployment.id,
      },
    });

    await ExecuteTasksWaitingForDeployService.enqueue(deployment.workerId);
  }
}
