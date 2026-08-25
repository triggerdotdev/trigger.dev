import type { FinalizeDeploymentRequestBody } from "@trigger.dev/core/v3/schemas";
import { Prisma } from "@trigger.dev/database";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { updateEnvConcurrencyLimits } from "../runQueue.server";
import { PerformDeploymentAlertsService } from "./alerts/performDeploymentAlerts.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { ChangeCurrentDeploymentService } from "./changeCurrentDeployment.server";
import { projectPubSub } from "./projectPubSub.server";
import { FailDeploymentService } from "./failDeployment.server";
import { TimeoutDeploymentService } from "./timeoutDeployment.server";
import { DeploymentService } from "./deployment.server";
import { recordDeploymentLifecycle } from "./recordDeploymentLifecycle.server";
import { engine } from "../runEngine.server";
import { tryCatch } from "@trigger.dev/core";
import { externalDeploymentCacheInstance } from "~/services/externalDeploymentCacheInstance.server";

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
    const deployedAt = new Date();
    const imageReference = imageDigest
      ? `${deployment.imageReference}@${imageDigest}`
      : deployment.imageReference;

    // Guarded: stops a concurrent transition (e.g. a late timeout) from double-committing
    const { count: updatedCount } = await this._prisma.workerDeployment.updateMany({
      where: {
        id: deployment.id,
        status: "DEPLOYING",
      },
      data: {
        status: "DEPLOYED",
        deployedAt,
        // Only add the digest, if any
        imageReference: imageDigest ? imageReference : undefined,
        buildEnvVars: Prisma.DbNull,
      },
    });

    if (updatedCount === 0) {
      logger.warn("Worker deployment left DEPLOYING concurrently, skipping finalize", {
        id: deployment.id,
      });
      throw new ServiceValidationError("Worker deployment is not in DEPLOYING status");
    }

    const finalizedDeployment = {
      ...deployment,
      status: "DEPLOYED" as const,
      deployedAt,
      imageReference,
      buildEnvVars: null,
    };

    recordDeploymentLifecycle({
      status: "DEPLOYED",
      deployment: finalizedDeployment,
      environment: {
        organizationId: authenticatedEnv.organizationId,
        projectId: authenticatedEnv.projectId,
        projectRef: authenticatedEnv.project.externalRef,
        environmentId: authenticatedEnv.id,
        environmentType: authenticatedEnv.type,
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

      await updateEnvConcurrencyLimits(authenticatedEnv, undefined, this._prisma);
    } catch (err) {
      logger.error("Failed to publish WORKER_CREATED event", { err });
    }

    if (deployment.externalId) {
      const [cacheError] = await tryCatch(
        externalDeploymentCacheInstance.setIfNewer(authenticatedEnv.id, deployment.externalId, {
          workerId: deployment.worker.id,
          version: deployment.worker.version,
          sdkVersion: deployment.worker.sdkVersion ?? "",
          cliVersion: deployment.worker.cliVersion ?? "",
        })
      );

      if (cacheError) {
        logger.error("Error caching external deployment resolution", { error: cacheError });
      }
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
