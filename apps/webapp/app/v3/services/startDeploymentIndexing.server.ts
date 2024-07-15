import { type StartDeploymentIndexingRequestBody } from '@trigger.dev/core/v3/schemas';
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { registryProxy } from "../registryProxy.server";
import { BaseService } from "./baseService.server";
import { IndexDeploymentService } from "./indexDeployment.server";

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
        imageReference:
          registryProxy && body.selfHosted !== true
            ? registryProxy.rewriteImageReference(body.imageReference)
            : body.imageReference,
        status: "DEPLOYING",
        builtAt: new Date(),
      },
    });

    await IndexDeploymentService.enqueue(deployment.id);

    return deployment;
  }
}
