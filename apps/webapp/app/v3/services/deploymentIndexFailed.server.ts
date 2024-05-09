import { PerformDeploymentAlertsService } from "./alerts/performDeploymentAlerts.server";
import { BaseService } from "./baseService.server";

export class DeploymentIndexFailed extends BaseService {
  public async call(
    maybeFriendlyId: string,
    error: { name: string; message: string; stack?: string }
  ) {
    const isFriendlyId = maybeFriendlyId.startsWith("deployment_");

    const deployment = await this._prisma.workerDeployment.update({
      where: isFriendlyId
        ? {
            friendlyId: maybeFriendlyId,
          }
        : {
            id: maybeFriendlyId,
          },
      data: {
        status: "FAILED",
        failedAt: new Date(),
        errorData: error,
      },
    });

    await PerformDeploymentAlertsService.enqueue(deployment.id, this._prisma);

    return deployment;
  }
}
