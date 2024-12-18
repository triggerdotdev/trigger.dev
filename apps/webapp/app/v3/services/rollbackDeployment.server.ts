import { logger } from "~/services/logger.server";
import { BaseService } from "./baseService.server";
import { WorkerDeployment, WorkerInstanceGroupType } from "@trigger.dev/database";
import { CURRENT_DEPLOYMENT_LABEL } from "~/consts";
import { ExecuteTasksWaitingForDeployService } from "./executeTasksWaitingForDeploy";

export class RollbackDeploymentService extends BaseService {
  public async call(deployment: WorkerDeployment) {
    if (deployment.status !== "DEPLOYED") {
      logger.error("Can't roll back to unsuccessful deployment", { id: deployment.id });
      return;
    }

    if (deployment.type !== WorkerInstanceGroupType.MANAGED) {
      logger.error("Can only roll back managed deployments", {
        id: deployment.id,
        type: deployment.type,
      });
      return;
    }

    const promotion = await this._prisma.workerDeploymentPromotion.findFirst({
      where: {
        deploymentId: deployment.id,
        label: CURRENT_DEPLOYMENT_LABEL,
      },
    });

    if (promotion) {
      logger.error(`Deployment is already the current deployment`, { id: deployment.id });
      return;
    }

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

    if (deployment.workerId) {
      await ExecuteTasksWaitingForDeployService.enqueue(deployment.workerId, this._prisma);
    }

    return {
      id: deployment.id,
    };
  }
}
