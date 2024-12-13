import { CreateBackgroundWorkerRequestBody } from "@trigger.dev/core/v3";
import type { BackgroundWorker } from "@trigger.dev/database";
import { CURRENT_DEPLOYMENT_LABEL } from "~/consts";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { socketIo } from "../handleSocketIo.server";
import { updateEnvConcurrencyLimits } from "../runQueue.server";
import { PerformDeploymentAlertsService } from "./alerts/performDeploymentAlerts.server";
import { BaseService } from "./baseService.server";
import { createBackgroundTasks, syncDeclarativeSchedules } from "./createBackgroundWorker.server";
import { ExecuteTasksWaitingForDeployService } from "./executeTasksWaitingForDeploy";
import { projectPubSub } from "./projectPubSub.server";
import { TimeoutDeploymentService } from "./timeoutDeployment.server";

export class CreateDeployedBackgroundWorkerService extends BaseService {
  public async call(
    projectRef: string,
    environment: AuthenticatedEnvironment,
    deploymentId: string,
    body: CreateBackgroundWorkerRequestBody
  ): Promise<BackgroundWorker | undefined> {
    return this.traceWithEnv("call", environment, async (span) => {
      span.setAttribute("projectRef", projectRef);

      const deployment = await this._prisma.workerDeployment.findUnique({
        where: {
          friendlyId: deploymentId,
        },
      });

      if (!deployment) {
        return;
      }

      if (deployment.status !== "DEPLOYING") {
        return;
      }

      const backgroundWorker = await this._prisma.backgroundWorker.create({
        data: {
          friendlyId: generateFriendlyId("worker"),
          version: deployment.version,
          runtimeEnvironmentId: environment.id,
          projectId: environment.projectId,
          metadata: body.metadata,
          contentHash: body.metadata.contentHash,
          cliVersion: body.metadata.cliPackageVersion,
          sdkVersion: body.metadata.packageVersion,
          supportsLazyAttempts: body.supportsLazyAttempts,
        },
      });

      try {
        await createBackgroundTasks(
          body.metadata.tasks,
          backgroundWorker,
          environment,
          this._prisma
        );
        await syncDeclarativeSchedules(
          body.metadata.tasks,
          backgroundWorker,
          environment,
          this._prisma
        );
      } catch (error) {
        const name = error instanceof Error ? error.name : "UnknownError";
        const message = error instanceof Error ? error.message : JSON.stringify(error);

        await this._prisma.workerDeployment.update({
          where: {
            id: deployment.id,
          },
          data: {
            status: "FAILED",
            failedAt: new Date(),
            errorData: {
              name,
              message,
            },
          },
        });

        throw error;
      }

      // Link the deployment with the background worker
      await this._prisma.workerDeployment.update({
        where: {
          id: deployment.id,
        },
        data: {
          status: "DEPLOYED",
          workerId: backgroundWorker.id,
          deployedAt: new Date(),
        },
      });

      //set this deployment as the current deployment for this environment
      await this._prisma.workerDeploymentPromotion.upsert({
        where: {
          environmentId_label: {
            environmentId: environment.id,
            label: CURRENT_DEPLOYMENT_LABEL,
          },
        },
        create: {
          deploymentId: deployment.id,
          environmentId: environment.id,
          label: CURRENT_DEPLOYMENT_LABEL,
        },
        update: {
          deploymentId: deployment.id,
        },
      });

      try {
        //send a notification that a new worker has been created
        await projectPubSub.publish(
          `project:${environment.projectId}:env:${environment.id}`,
          "WORKER_CREATED",
          {
            environmentId: environment.id,
            environmentType: environment.type,
            createdAt: backgroundWorker.createdAt,
            taskCount: body.metadata.tasks.length,
            type: "deployed",
          }
        );
        await updateEnvConcurrencyLimits(environment);
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
          envId: environment.id,
          envType: environment.type,
          orgId: environment.organizationId,
          projectId: deployment.projectId,
        });
      }

      await ExecuteTasksWaitingForDeployService.enqueue(backgroundWorker.id, this._prisma);
      await PerformDeploymentAlertsService.enqueue(deployment.id, this._prisma);
      await TimeoutDeploymentService.dequeue(deployment.id, this._prisma);

      return backgroundWorker;
    });
  }
}
