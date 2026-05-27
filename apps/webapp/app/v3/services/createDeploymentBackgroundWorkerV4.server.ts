import { CreateBackgroundWorkerRequestBody, logger, tryCatch } from "@trigger.dev/core/v3";
import { BackgroundWorkerId } from "@trigger.dev/core/v3/isomorphic";
import type { BackgroundWorker, PrismaClientOrTransaction, WorkerDeployment } from "@trigger.dev/database";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { type TaskMetadataCache } from "~/services/taskMetadataCache.server";
import { taskMetadataCacheInstance } from "~/services/taskMetadataCacheInstance.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import {
  createBackgroundFiles,
  createWorkerResources,
  stripBackgroundWorkerMetadataForStorage,
  syncDeclarativeSchedules,
} from "./createBackgroundWorker.server";
import { TimeoutDeploymentService } from "./timeoutDeployment.server";
import { env } from "~/env.server";

export class CreateDeploymentBackgroundWorkerServiceV4 extends BaseService {
  private readonly _taskMetaCache: TaskMetadataCache;

  constructor(
    prisma?: PrismaClientOrTransaction,
    replica?: PrismaClientOrTransaction,
    taskMetaCache: TaskMetadataCache = taskMetadataCacheInstance
  ) {
    super(prisma, replica);
    this._taskMetaCache = taskMetaCache;
  }

  public async call(
    environment: AuthenticatedEnvironment,
    deploymentId: string,
    body: CreateBackgroundWorkerRequestBody
  ): Promise<BackgroundWorker | undefined> {
    return this.traceWithEnv("call", environment, async (span) => {
      span.setAttribute("deploymentId", deploymentId);

      const { buildPlatform, targetPlatform } = body;

      if (buildPlatform) {
        span.setAttribute("buildPlatform", buildPlatform);
      }
      if (targetPlatform) {
        span.setAttribute("targetPlatform", targetPlatform);
      }

      const deployment = await this._prisma.workerDeployment.findFirst({
        where: {
          friendlyId: deploymentId,
        },
      });

      if (!deployment) {
        return;
      }

      // Handle multi-platform builds
      const deploymentPlatforms = deployment.imagePlatform?.split(",") ?? [];
      if (deploymentPlatforms.length > 1) {
        span.setAttribute("deploymentPlatforms", deploymentPlatforms.join(","));

        // We will only create a background worker for the first platform
        const firstPlatform = deploymentPlatforms[0];

        if (targetPlatform && firstPlatform !== targetPlatform) {
          throw new ServiceValidationError(
            `Ignoring target platform ${targetPlatform} for multi-platform deployment ${deployment.imagePlatform}`,
            400
          );
        }
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
          metadata: stripBackgroundWorkerMetadataForStorage(body.metadata),
          contentHash: body.metadata.contentHash,
          cliVersion: body.metadata.cliPackageVersion,
          sdkVersion: body.metadata.packageVersion,
          supportsLazyAttempts: body.supportsLazyAttempts,
          engine: body.engine,
          runtime: body.metadata.runtime,
          runtimeVersion: body.metadata.runtimeVersion,
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

      const [resourcesError, workerTaskEntries] = await tryCatch(
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

      // V4 build path: worker created but NOT yet promoted to current. Write
      // only the `task-meta:by-worker:{workerId}` keyspace so locked-version
      // triggers against this build hit the cache. Promotion (which writes the
      // env keyspace) happens later via finalizeDeployment → changeCurrentDeployment.
      // Cache calls log+swallow internally, so a Redis blip can't stall the
      // deployment state machine. Empty entries clears stale hashes.
      if (workerTaskEntries) {
        await this._taskMetaCache.populateByWorker(backgroundWorker.id, workerTaskEntries);
      }

      const [schedulesError] = await tryCatch(
        syncDeclarativeSchedules(body.metadata.tasks, backgroundWorker, environment, this._prisma)
      );

      if (schedulesError) {
        if (schedulesError instanceof ServiceValidationError) {
          // Customer schedule config (typically invalid cron). Surface to
          // client via the rethrow; system returns gracefully.
          logger.warn("Error syncing declarative schedules", {
            error: schedulesError.message,
          });

          await this.#failBackgroundWorkerDeployment(deployment, schedulesError);
          throw schedulesError;
        }

        // Wrapping the underlying error into a ServiceValidationError below
        // would otherwise hide it once the SDK-level filter drops SVEs; log at
        // error so the underlying cause stays visible. Mirrors the
        // waitpointCompletionPacket.server.ts pattern from dac9c83bd.
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
          // runtime is already set when the deployment is created, we only need to set the version
          runtimeVersion: body.metadata.runtimeVersion,
        },
      });

      await TimeoutDeploymentService.enqueue(
        deployment.id,
        "DEPLOYING",
        "Indexing timed out",
        new Date(Date.now() + env.DEPLOY_TIMEOUT_MS)
      );

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
