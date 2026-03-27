import type { FinalizeDeploymentRequestBody } from "@trigger.dev/core/v3/schemas";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { socketIo } from "../handleSocketIo.server";
import { updateEnvConcurrencyLimits } from "../runQueue.server";
import { PerformDeploymentAlertsService } from "./alerts/performDeploymentAlerts.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { ChangeCurrentDeploymentService } from "./changeCurrentDeployment.server";
import { projectPubSub } from "./projectPubSub.server";
import { FailDeploymentService } from "./failDeployment.server";
import { TimeoutDeploymentService } from "./timeoutDeployment.server";
import { DeploymentService } from "./deployment.server";
import { engine } from "../runEngine.server";
import { tryCatch } from "@trigger.dev/core";
import { ComputeTemplateCreationService } from "./computeTemplateCreation.server";

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

    // Compute template creation (before setting DEPLOYED)
    const templateService = new ComputeTemplateCreationService();
    const templateMode = await templateService.resolveMode(
      authenticatedEnv.projectId,
      this._prisma
    );

    if (templateMode === "required" && deployment.imageReference) {
      logger.info("Creating compute template (required mode)", {
        id,
        imageReference: deployment.imageReference,
      });

      const templateResult = await templateService.createTemplate(deployment.imageReference);

      if (!templateResult.success) {
        logger.error("Compute template creation failed", {
          id,
          imageReference: deployment.imageReference,
          error: templateResult.error,
        });

        const failService = new FailDeploymentService();
        await failService.call(authenticatedEnv, deployment.friendlyId, {
          error: {
            name: "TemplateCreationFailed",
            message: `Failed to create compute template: ${templateResult.error}`,
          },
        });

        throw new ServiceValidationError(
          `Compute template creation failed: ${templateResult.error}`
        );
      }

      logger.info("Compute template created", {
        id,
        imageReference: deployment.imageReference,
      });
    }

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

    const deploymentService = new DeploymentService();
    await deploymentService
      .appendToEventLog(authenticatedEnv.project, finalizedDeployment, [
        {
          type: "finalized",
          data: {
            result: "succeeded",
          },
        },
      ])
      .orTee((error) => {
        logger.error("Failed to append finalized deployment event to event log", { error });
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

    if (deployment.worker.engine === "V2") {
      const [schedulePendingVersionsError] = await tryCatch(
        engine.scheduleEnqueueRunsForBackgroundWorker(deployment.worker.id)
      );

      if (schedulePendingVersionsError) {
        logger.error("Error scheduling pending versions", {
          error: schedulePendingVersionsError,
        });
      }
    }

    await PerformDeploymentAlertsService.enqueue(deployment.id);

    // Shadow mode: fire-and-forget template creation after deploy is finalized
    if (templateMode === "shadow" && deployment.imageReference) {
      templateService.createTemplate(deployment.imageReference, { background: true }).catch((error) => {
        logger.error("Shadow compute template creation failed", {
          id,
          imageReference: deployment.imageReference,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

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
