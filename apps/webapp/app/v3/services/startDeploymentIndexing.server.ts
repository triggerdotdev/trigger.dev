import { StartDeploymentIndexingRequestBody } from "@trigger.dev/core/v3";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { workerQueue } from "~/services/worker.server";
import { BaseService } from "./baseService.server";
import { registryProxy } from "../registryProxy.server";

export class StartDeploymentIndexing extends BaseService {
  public async call(
    environment: AuthenticatedEnvironment,
    deploymentId: string,
    body: StartDeploymentIndexingRequestBody
  ) {
    const deployment = await this._prisma.workerDeployment.update({
      where: {
        friendlyId: deploymentId,
      },
      data: {
        imageReference: registryProxy
          ? registryProxy.rewriteImageReference(body.imageReference)
          : body.imageReference,
        status: "DEPLOYING",
      },
    });

    await workerQueue.enqueue("v3.indexDeployment", { id: deployment.id });

    return deployment;
  }
}
