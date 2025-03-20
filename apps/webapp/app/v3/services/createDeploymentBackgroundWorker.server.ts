import { CreateBackgroundWorkerRequestBody } from "@trigger.dev/core/v3";
import type { BackgroundWorker } from "@trigger.dev/database";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { BaseService } from "./baseService.server";
import {
  createBackgroundFiles,
  createWorkerResources,
  syncDeclarativeSchedules,
} from "./createBackgroundWorker.server";
import { TimeoutDeploymentService } from "./timeoutDeployment.server";
import { BackgroundWorkerId } from "@trigger.dev/core/v3/isomorphic";

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

      try {
        const tasksToBackgroundFiles = await createBackgroundFiles(
          body.metadata.sourceFiles,
          backgroundWorker,
          environment,
          this._prisma
        );
        await createWorkerResources(
          body.metadata.tasks,
          backgroundWorker,
          environment,
          this._prisma,
          tasksToBackgroundFiles
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
          status: "DEPLOYING",
          workerId: backgroundWorker.id,
          builtAt: new Date(),
        },
      });

      await TimeoutDeploymentService.dequeue(deployment.id, this._prisma);

      return backgroundWorker;
    });
  }
}
