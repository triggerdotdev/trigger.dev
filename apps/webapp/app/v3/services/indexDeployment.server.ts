import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { socketIo } from "../handleSocketIo.server";
import { BaseService } from "./baseService.server";
import { DeploymentIndexFailed } from "./deploymentIndexFailed.server";
import { TimeoutDeploymentService } from "./timeoutDeployment.server";
import { workerQueue } from "~/services/worker.server";

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
      const responses = await socketIo.providerNamespace.timeout(30_000).emitWithAck("INDEX", {
        version: "v1",
        shortCode: deployment.shortCode,
        imageTag: deployment.imageReference,
        apiKey: deployment.environment.apiKey,
        apiUrl: env.APP_ORIGIN,
        // identifiers
        envId: deployment.environmentId,
        envType: deployment.environment.type,
        projectId: deployment.projectId,
        orgId: deployment.environment.organizationId,
      });

      logger.debug("Index ACK received", { responses });

      if (responses.length === 0) {
        // timeout the deployment if 50 seconds have passed and the deployment is still not indexed
        await TimeoutDeploymentService.enqueue(
          deployment.id,
          "DEPLOYING",
          "Could not index deployment in time",
          new Date(Date.now() + 50_000)
        );
      } else {
        const indexFailed = new DeploymentIndexFailed();

        for (const response of responses) {
          if (!response.success) {
            await indexFailed.call(deployment.friendlyId, response.error);
          }
        }
      }
    } catch (error) {
      logger.error("No index ACK received within timeout", { error });

      const indexFailed = new DeploymentIndexFailed();

      await indexFailed.call(
        deployment.friendlyId,
        error instanceof Error
          ? { message: error.message, name: error.name }
          : { message: "Could not index deployment in time", name: "TimeoutError" }
      );
    }
  }

  static async enqueue(id: string) {
    const runAt = new Date(Date.now() + 1000); // 1 second from now (give eventually-consistent DO time)

    await workerQueue.enqueue("v3.indexDeployment", { id }, { runAt });
  }
}
