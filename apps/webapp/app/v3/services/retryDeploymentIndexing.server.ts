import { BaseService } from "./baseService.server";
import { IndexDeploymentService } from "./indexDeployment.server";

export class RetryDeploymentIndexingService extends BaseService {
  public async call(deploymentId: string) {
    const deployment = await this._prisma.workerDeployment.findUnique({
      where: {
        id: deploymentId,
      },
    });

    if (!deployment) {
      throw new Error("Deployment not found");
    }

    if (deployment.status !== "FAILED" || !deployment.builtAt) {
      throw new Error("Deployment indexing not failed");
    }

    await this._prisma.workerDeployment.update({
      where: {
        id: deploymentId,
      },
      data: {
        status: "DEPLOYING",
      },
    });

    await IndexDeploymentService.enqueue(deployment.id);

    return deployment;
  }
}
