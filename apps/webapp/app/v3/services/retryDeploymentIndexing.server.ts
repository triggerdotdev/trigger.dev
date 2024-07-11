import { deploymentIndexingIsRetryable } from "../deploymentStatus";
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

    if (!deploymentIndexingIsRetryable(deployment)) {
      throw new Error("Deployment indexing not retryable");
    }

    const latestDeployment = await this._prisma.workerDeployment.findFirst({
      where: {
        projectId: deployment.projectId,
      },
      select: {
        id: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!latestDeployment || latestDeployment.id !== deployment.id) {
      throw new Error("Deployment is not the latest");
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
