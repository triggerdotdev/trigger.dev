import { FinalizeDeploymentRequestBody } from "@trigger.dev/core/v3/schemas";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { socketIo } from "../handleSocketIo.server";
import { updateEnvConcurrencyLimits } from "../runQueue.server";
import { PerformDeploymentAlertsService } from "./alerts/performDeploymentAlerts.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { ChangeCurrentDeploymentService } from "./changeCurrentDeployment.server";
import { projectPubSub } from "./projectPubSub.server";
import { FailDeploymentService } from "./failDeployment.server";
import { TimeoutDeploymentService } from "./timeoutDeployment.server";

export class FinalizeDeploymentService extends BaseService {
  public async call(
    authenticatedEnv: AuthenticatedEnvironment,
    id: string,
    body: FinalizeDeploymentRequestBody
  ) {
    const deployment = await this._prisma.workerDeployment.findFirst({
      where: {
        friendlyId: id,
        environmentId: authenticatedEnv.id,
      },
      include: {
        worker: {
          include: {
            tasks: true,
          },
        },
      },
    });

    if (!deployment) {
      logger.error("Worker deployment not found", { id });
      return;
    }

    if (!deployment.worker) {
      logger.error("Worker deployment does not have a worker", { id });

      const failService = new FailDeploymentService();
      await failService.call(authenticatedEnv, deployment.friendlyId, {
        error: {
          name: "MissingWorker",
          message: "Deployment does not have a worker",
        },
      });

      throw new ServiceValidationError("Worker deployment does not have a worker");
    }

    if (deployment.status === "DEPLOYED") {
      logger.debug("Worker deployment is already deployed", { id });

      return deployment;
    }

    if (deployment.status !== "DEPLOYING") {
      logger.error("Worker deployment is not in DEPLOYING status", { id });
      throw new ServiceValidationError("Worker deployment is not in DEPLOYING status");
    }

    const imageDigest = validatedImageDigest(body.imageDigest);

    // Link the deployment with the background worker
    const finalizedDeployment = await this._prisma.workerDeployment.update({
      where: {
        id: deployment.id,
      },
      data: {
        status: "DEPLOYED",
        deployedAt: new Date(),
        // Only add the digest, if any
        imageReference: imageDigest ? `${deployment.imageReference}@${imageDigest}` : undefined,
      },
    });

    await TimeoutDeploymentService.dequeue(deployment.id, this._prisma);

    if (typeof body.skipPromotion === "undefined" || !body.skipPromotion) {
      const promotionService = new ChangeCurrentDeploymentService();

      await promotionService.call(finalizedDeployment, "promote");
    }

    try {
      //send a notification that a new worker has been created
      await projectPubSub.publish(
        `project:${authenticatedEnv.projectId}:env:${authenticatedEnv.id}`,
        "WORKER_CREATED",
        {
          environmentId: authenticatedEnv.id,
          environmentType: authenticatedEnv.type,
          createdAt: authenticatedEnv.createdAt,
          taskCount: deployment.worker.tasks.length,
          type: "deployed",
        }
      );

      await updateEnvConcurrencyLimits(authenticatedEnv);
    } catch (err) {
      logger.error("Failed to publish WORKER_CREATED event", { err });
    }

    if (finalizedDeployment.imageReference) {
      socketIo.providerNamespace.emit("PRE_PULL_DEPLOYMENT", {
        version: "v1",
        imageRef: finalizedDeployment.imageReference,
        shortCode: finalizedDeployment.shortCode,
        // identifiers
        deploymentId: finalizedDeployment.id,
        envId: authenticatedEnv.id,
        envType: authenticatedEnv.type,
        orgId: authenticatedEnv.organizationId,
        projectId: finalizedDeployment.projectId,
      });
    }

    await PerformDeploymentAlertsService.enqueue(deployment.id);

    return finalizedDeployment;
  }
}

function validatedImageDigest(imageDigest?: string): string | undefined {
  if (!imageDigest) {
    return;
  }

  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest.trim())) {
    logger.error("Invalid image digest", { imageDigest });
    return;
  }

  return imageDigest.trim();
}
