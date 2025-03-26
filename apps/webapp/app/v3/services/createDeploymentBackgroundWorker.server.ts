import { CreateBackgroundWorkerRequestBody, logger, tryCatch } from "@trigger.dev/core/v3";
import { BackgroundWorkerId } from "@trigger.dev/core/v3/isomorphic";
import type { BackgroundWorker, WorkerDeployment } from "@trigger.dev/database";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import {
  createBackgroundFiles,
  createWorkerResources,
  syncDeclarativeSchedules,
} from "./createBackgroundWorker.server";
import { TimeoutDeploymentService } from "./timeoutDeployment.server";

export class CreateDeploymentBackgroundWorkerService extends BaseService {
  public async call(
    environment: AuthenticatedEnvironment,
    deploymentId: string,
    body: CreateBackgroundWorkerRequestBody
  ): Promise<BackgroundWorker | undefined> {
    return this.traceWithEnv("call", environment, async (span) => {
      span.setAttribute("deploymentId", deploymentId);

      const deployment = await this._prisma.workerDeployment.findFirst({
        where: {
          friendlyId: deploymentId,
        },
      });

      if (!deployment) {
        return;
      }

      if (deployment.status !== "BUILDING") {
        return;
      }

      const backgroundWorker = await this._prisma.backgroundWorker.create({
        data: {
          ...BackgroundWorkerId.generate(),
          version: deployment.version,
          runtimeEnvironmentId: environment.id,
          projectId: environment.projectId,
          metadata: body.metadata,
          contentHash: body.metadata.contentHash,
          cliVersion: body.metadata.cliPackageVersion,
          sdkVersion: body.metadata.packageVersion,
          supportsLazyAttempts: body.supportsLazyAttempts,
          engine: body.engine,
        },
      });

      //upgrade the project to engine "V2" if it's not already
      if (environment.project.engine === "V1" && body.engine === "V2") {
        await this._prisma.project.update({
          where: {
            id: environment.project.id,
          },
          data: {
            engine: "V2",
          },
        });
      }

      const [filesError, tasksToBackgroundFiles] = await tryCatch(
        createBackgroundFiles(
          body.metadata.sourceFiles,
          backgroundWorker,
          environment,
          this._prisma
        )
      );

      if (filesError) {
        logger.error("Error creating background worker files", {
          error: filesError,
        });

        const serviceError = new ServiceValidationError("Error creating background worker files");

        await this.#failBackgroundWorkerDeployment(deployment, serviceError);

        throw serviceError;
      }

      const [resourcesError] = await tryCatch(
        createWorkerResources(
          body.metadata,
          backgroundWorker,
          environment,
          this._prisma,
          tasksToBackgroundFiles
        )
      );

      if (resourcesError) {
        logger.error("Error creating background worker resources", {
          error: resourcesError,
        });

        const serviceError = new ServiceValidationError(
          "Error creating background worker resources"
        );

        await this.#failBackgroundWorkerDeployment(deployment, serviceError);

        throw serviceError;
      }

      const [schedulesError] = await tryCatch(
        syncDeclarativeSchedules(body.metadata.tasks, backgroundWorker, environment, this._prisma)
      );

      if (schedulesError) {
        logger.error("Error syncing declarative schedules", {
          error: schedulesError,
        });

        const serviceError = new ServiceValidationError("Error syncing declarative schedules");

        await this.#failBackgroundWorkerDeployment(deployment, serviceError);

        throw serviceError;
      }

      // Link the deployment with the background worker
      await this._prisma.workerDeployment.update({
        where: {
          id: deployment.id,
        },
        data: {
          status: "DEPLOYING",
          workerId: backgroundWorker.id,
          builtAt: new Date(),
          type: backgroundWorker.engine === "V2" ? "MANAGED" : "V1",
        },
      });

      await TimeoutDeploymentService.dequeue(deployment.id, this._prisma);

      return backgroundWorker;
    });
  }

  async #failBackgroundWorkerDeployment(deployment: WorkerDeployment, error: Error) {
    await this._prisma.workerDeployment.update({
      where: {
        id: deployment.id,
      },
      data: {
        status: "FAILED",
        failedAt: new Date(),
        errorData: {
          name: error.name,
          message: error.message,
        },
      },
    });

    await TimeoutDeploymentService.dequeue(deployment.id, this._prisma);

    throw error;
  }
}
