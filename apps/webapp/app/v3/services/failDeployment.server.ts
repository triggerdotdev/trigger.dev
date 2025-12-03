import { PerformDeploymentAlertsService } from "./alerts/performDeploymentAlerts.server";
import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";
import { type WorkerDeploymentStatus } from "@trigger.dev/database";
import { type FailDeploymentRequestBody } from "@trigger.dev/core/v3/schemas";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { DeploymentService } from "./deployment.server";

export const FINAL_DEPLOYMENT_STATUSES: WorkerDeploymentStatus[] = [
  "CANCELED",
  "DEPLOYED",
  "FAILED",
  "TIMED_OUT",
];

export class FailDeploymentService extends BaseService {
  public async call(
    authenticatedEnv: AuthenticatedEnvironment,
    friendlyId: string,
    params: FailDeploymentRequestBody
  ) {
    const deployment = await this._prisma.workerDeployment.findFirst({
      where: {
        friendlyId,
        environmentId: authenticatedEnv.id,
      },
    });

    if (!deployment) {
      logger.error("Worker deployment not found", { friendlyId });
      return;
    }

    if (FINAL_DEPLOYMENT_STATUSES.includes(deployment.status)) {
      logger.error("Worker deployment already in final state", {
        id: deployment.id,
        friendlyId,
        status: deployment.status,
      });
      return;
    }

    const failedDeployment = await this._prisma.workerDeployment.update({
      where: {
        id: deployment.id,
      },
      data: {
        status: "FAILED",
        failedAt: new Date(),
        errorData: params.error,
      },
    });

    const deploymentService = new DeploymentService();
    await deploymentService
      .appendToEventLog(authenticatedEnv.project, failedDeployment, [
        {
          type: "finalized",
          data: {
            result: "failed",
            message: params.error.message,
          },
        },
      ])
      .orTee((error) => {
        logger.error("Failed to append failed deployment event to event log", { error });
      });

    await PerformDeploymentAlertsService.enqueue(failedDeployment.id);

    return failedDeployment;
  }
}
