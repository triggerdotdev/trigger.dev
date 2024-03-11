import { BaseService } from "./baseService.server";

export class DeploymentIndexFailed extends BaseService {
  public async call(
    deploymentId: string,
    error: { name: string; message: string; stack?: string }
  ) {
    const deployment = await this._prisma.workerDeployment.update({
      where: {
        friendlyId: deploymentId,
      },
      data: {
        status: "FAILED",
        failedAt: new Date(),
        errorData: error,
      },
    });

    return deployment;
  }
}
