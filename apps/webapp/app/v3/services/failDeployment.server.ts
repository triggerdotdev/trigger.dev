import { PerformDeploymentAlertsService } from "./alerts/performDeploymentAlerts.server";
import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";
import { WorkerDeploymentStatus } from "@trigger.dev/database";
import { FailDeploymentRequestBody } from "@trigger.dev/core/v3/schemas";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";

const FINAL_DEPLOYMENT_STATUSES: WorkerDeploymentStatus[] = [
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

    await PerformDeploymentAlertsService.enqueue(failedDeployment.id);

    return failedDeployment;
  }
}
