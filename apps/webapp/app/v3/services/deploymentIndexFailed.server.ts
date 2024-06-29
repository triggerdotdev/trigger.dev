import { PerformDeploymentAlertsService } from "./alerts/performDeploymentAlerts.server";
import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";
import { WorkerDeploymentStatus } from "@trigger.dev/database";

const FINAL_DEPLOYMENT_STATUSES: WorkerDeploymentStatus[] = [
  "CANCELED",
  "DEPLOYED",
  "FAILED",
  "TIMED_OUT",
];

export class DeploymentIndexFailed extends BaseService {
  public async call(
    maybeFriendlyId: string,
    error: {
      name: string;
      message: string;
      stack?: string;
      stderr?: string;
    },
    overrideCompletion = false
  ) {
    const isFriendlyId = maybeFriendlyId.startsWith("deployment_");

    const deployment = await this._prisma.workerDeployment.findUnique({
      where: isFriendlyId
        ? {
            friendlyId: maybeFriendlyId,
          }
        : {
            id: maybeFriendlyId,
          },
    });

    if (!deployment) {
      logger.error("Worker deployment not found", { maybeFriendlyId });
      return;
    }

    if (FINAL_DEPLOYMENT_STATUSES.includes(deployment.status)) {
      if (overrideCompletion) {
        logger.error("No support for overriding final deployment statuses just yet", {
          id: deployment.id,
          status: deployment.status,
          previousError: deployment.errorData,
          incomingError: error,
        });
      }

      logger.error("Worker deployment already in final state", {
        id: deployment.id,
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
        errorData: error,
      },
    });

    await PerformDeploymentAlertsService.enqueue(failedDeployment.id, this._prisma);

    return failedDeployment;
  }
}
