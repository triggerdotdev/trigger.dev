import { logger } from "~/services/logger.server";
import { socketIo } from "../handleSocketIo.server";
import { BaseService } from "./baseService.server";
import { env } from "~/env.server";
import { DeploymentIndexFailed } from "./deploymentIndexFailed.server";

export class IndexDeploymentService extends BaseService {
  public async call(id: string) {
    const deployment = await this._prisma.workerDeployment.findUnique({
      where: {
        id,
      },
      include: {
        environment: true,
      },
    });

    if (!deployment) {
      logger.error(`No worker deployment with this ID: ${id}`);
      return;
    }

    if (!deployment.imageReference) {
      logger.error(`No image reference for worker deployment: ${id}`);
      return;
    }

    if (deployment.workerId) {
      logger.debug(
        `Deployment have already been indexed for ${deployment.friendlyId}. Refreshing worker timestamp.`
      );

      await this._prisma.backgroundWorker.update({
        where: {
          id: deployment.workerId,
        },
        data: {
          updatedAt: new Date(),
        },
      });
      return;
    }

    // just broadcast for now - there should only ever be one provider connected
    try {
      const responses = await socketIo.providerNamespace.timeout(10_000).emitWithAck("INDEX", {
        version: "v1",
        contentHash: deployment.contentHash,
        imageTag: deployment.imageReference,
        envId: deployment.environmentId,
        apiKey: deployment.environment.apiKey,
        apiUrl: env.APP_ORIGIN,
      });

      const indexFailed = new DeploymentIndexFailed();

      for (const response of responses) {
        if (!response.success) {
          await indexFailed.call(deployment.friendlyId, response.error);
        }
      }
    } catch (error) {
      logger.error("No index ACK received within timeout", { error });
    }
  }
}
