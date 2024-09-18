import { FinalizeDeploymentRequestBody } from "@trigger.dev/core/v3/schemas";
import { CURRENT_DEPLOYMENT_LABEL } from "~/consts";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { socketIo } from "../handleSocketIo.server";
import { marqs } from "../marqs/index.server";
import { registryProxy } from "../registryProxy.server";
import { PerformDeploymentAlertsService } from "./alerts/performDeploymentAlerts.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { ExecuteTasksWaitingForDeployService } from "./executeTasksWaitingForDeploy";
import { projectPubSub } from "./projectPubSub.server";

export class FinalizeDeploymentService extends BaseService {
  public async call(
    authenticatedEnv: AuthenticatedEnvironment,
    id: string,
    body: FinalizeDeploymentRequestBody
  ) {
    const deployment = await this._prisma.workerDeployment.findUnique({
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

      // TODO: We need to fail the deployment here because it's not possible to deploy a worker without a worker

      throw new ServiceValidationError("Worker deployment does not have a worker");
    }

    if (deployment.status !== "DEPLOYING") {
      logger.error("Worker deployment is not in DEPLOYING status", { id });
      throw new ServiceValidationError("Worker deployment is not in DEPLOYING status");
    }

    // Link the deployment with the background worker
    const finalizedDeployment = await this._prisma.workerDeployment.update({
      where: {
        id: deployment.id,
      },
      data: {
        status: "DEPLOYED",
        deployedAt: new Date(),
        imageReference:
          registryProxy && body.selfHosted !== true
            ? registryProxy.rewriteImageReference(body.imageReference)
            : body.imageReference,
      },
    });

    //set this deployment as the current deployment for this environment
    await this._prisma.workerDeploymentPromotion.upsert({
      where: {
        environmentId_label: {
          environmentId: authenticatedEnv.id,
          label: CURRENT_DEPLOYMENT_LABEL,
        },
      },
      create: {
        deploymentId: finalizedDeployment.id,
        environmentId: authenticatedEnv.id,
        label: CURRENT_DEPLOYMENT_LABEL,
      },
      update: {
        deploymentId: finalizedDeployment.id,
      },
    });

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

      await marqs?.updateEnvConcurrencyLimits(authenticatedEnv);
    } catch (err) {
      logger.error("Failed to publish WORKER_CREATED event", { err });
    }

    if (deployment.imageReference) {
      socketIo.providerNamespace.emit("PRE_PULL_DEPLOYMENT", {
        version: "v1",
        imageRef: deployment.imageReference,
        shortCode: deployment.shortCode,
        // identifiers
        deploymentId: deployment.id,
        envId: authenticatedEnv.id,
        envType: authenticatedEnv.type,
        orgId: authenticatedEnv.organizationId,
        projectId: deployment.projectId,
      });
    }

    await ExecuteTasksWaitingForDeployService.enqueue(deployment.worker.id, this._prisma);
    await PerformDeploymentAlertsService.enqueue(deployment.id, this._prisma);

    return finalizedDeployment;
  }
}
