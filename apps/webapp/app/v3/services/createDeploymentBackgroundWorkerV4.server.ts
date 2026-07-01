import type { CreateBackgroundWorkerRequestBody } from "@trigger.dev/core/v3";
import { logger, tryCatch } from "@trigger.dev/core/v3";
import type {
  BackgroundWorker,
  PrismaClientOrTransaction,
  WorkerDeployment,
} from "@trigger.dev/database";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { type TaskMetadataCache } from "~/services/taskMetadataCache.server";
import { taskMetadataCacheInstance } from "~/services/taskMetadataCacheInstance.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import {
  createBackgroundFiles,
  createWorkerResources,
  syncDeclarativeSchedules,
} from "./createBackgroundWorker.server";
import { findOrCreateBackgroundWorker } from "./createDeploymentBackgroundWorkerV4/findOrCreateBackgroundWorker.server";
import { TimeoutDeploymentService } from "./timeoutDeployment.server";
import { recordDeploymentOutcome } from "./recordDeploymentOutcome.server";
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
        logger.warn("createDeploymentBackgroundWorker: deployment not found", {
          deploymentId,
          environmentId: environment.id,
          projectId: environment.projectId,
        });
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

      // Late-retry idempotency: if a worker was registered by a prior fully-
      // successful attempt and the deployment already moved past BUILDING, return
      // that worker so the CLI can finalize instead of seeing a 5xx.
      if (deployment.workerId) {
        const linkedWorker = await this._prisma.backgroundWorker.findFirst({
          where: { id: deployment.workerId },
        });
        if (linkedWorker) {
          return linkedWorker;
        }
      }

      if (deployment.status !== "BUILDING") {
        logger.warn("createDeploymentBackgroundWorker: deployment not in BUILDING state", {
          deploymentId,
          deploymentStatus: deployment.status,
          environmentId: environment.id,
          projectId: environment.projectId,
        });
        return;
      }

      const [findOrCreateError, backgroundWorker] = await tryCatch(
        findOrCreateBackgroundWorker(environment, deployment, body, this._prisma)
      );

      if (findOrCreateError) {
        // Definitive failures (e.g. contentHash drift) surface as
        // `ServiceValidationError` — fail the deployment so the operator sees it
        // immediately instead of waiting 8 minutes for the timeout. Transient
        // races throw a plain `Error` and propagate as 5xx without failing.
        if (findOrCreateError instanceof ServiceValidationError) {
          // `#failBackgroundWorkerDeployment` already throws its argument; the
          // outer `throw` covers the non-SVE branch.
          await this.#failBackgroundWorkerDeployment(deployment, findOrCreateError, environment);
        }
        throw findOrCreateError;
      }

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

        await this.#failBackgroundWorkerDeployment(deployment, serviceError, environment);

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
        if (resourcesError instanceof ServiceValidationError) {
          // Customer-facing config error (e.g. duplicate task ids). Surface the
          // real message to the client via the rethrow.
          logger.warn("Error creating background worker resources", {
            error: resourcesError.message,
          });

          await this.#failBackgroundWorkerDeployment(deployment, resourcesError, environment);
          throw resourcesError;
        }

        logger.error("Error creating background worker resources", {
          error: resourcesError,
        });

        const serviceError = new ServiceValidationError(
          "Error creating background worker resources"
        );

        await this.#failBackgroundWorkerDeployment(deployment, serviceError, environment);

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

          await this.#failBackgroundWorkerDeployment(deployment, schedulesError, environment);
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

        await this.#failBackgroundWorkerDeployment(deployment, serviceError, environment);

        throw serviceError;
      }

      // Guarded BUILDING → DEPLOYING transition. `updateMany` for optimistic concurrency control
      const { count: updatedCount } = await this._prisma.workerDeployment.updateMany({
        where: {
          id: deployment.id,
          status: "BUILDING",
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

      if (updatedCount === 0) {
        logger.warn(
          "createDeploymentBackgroundWorker: deployment no longer in BUILDING state, skipping DEPLOYING transition",
          {
            deploymentId,
            environmentId: environment.id,
            projectId: environment.projectId,
          }
        );
        return backgroundWorker;
      }

      await TimeoutDeploymentService.enqueue(
        deployment.id,
        "DEPLOYING",
        "Indexing timed out",
        new Date(Date.now() + env.DEPLOY_TIMEOUT_MS)
      );

      return backgroundWorker;
    });
  }

  async #failBackgroundWorkerDeployment(
    deployment: WorkerDeployment,
    error: Error,
    environment: AuthenticatedEnvironment
  ) {
    // Guarded BUILDING → FAILED transition, symmetric with the BUILDING → DEPLOYING
    // transition in `call()`. With idempotent retries, two attempts can run side-by-side;
    // without the predicate, one attempt's failure could downgrade the deployment after
    // the other already flipped it to DEPLOYING, leaving it stuck in FAILED with a worker.
    const { count: updatedCount } = await this._prisma.workerDeployment.updateMany({
      where: {
        id: deployment.id,
        status: "BUILDING",
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

    if (updatedCount === 0) {
      logger.warn(
        "failBackgroundWorkerDeployment: deployment moved out of BUILDING during call, skipping FAILED transition",
        {
          deploymentId: deployment.id,
          originalError: error.message,
        }
      );
    } else {
      // Only dequeue the timeout if we actually flipped to FAILED — otherwise a
      // sibling attempt may have just enqueued it as part of a successful
      // BUILDING → DEPLOYING transition.
      await TimeoutDeploymentService.dequeue(deployment.id, this._prisma);

      recordDeploymentOutcome({
        status: "FAILED",
        deploymentFriendlyId: deployment.friendlyId,
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        environmentId: environment.id,
        environmentType: environment.type,
        reason: error.message,
      });
    }

    throw error;
  }
}
