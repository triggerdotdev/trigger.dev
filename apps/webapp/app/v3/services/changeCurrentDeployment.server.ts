import { BackgroundWorkerMetadata, tryCatch } from "@trigger.dev/core/v3";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import { PrismaClientOrTransaction, WorkerDeployment } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { syncTaskIdentifiers } from "~/services/taskIdentifierRegistry.server";
import {
  type TaskMetadataCache,
  type TaskMetadataEntry,
} from "~/services/taskMetadataCache.server";
import { taskMetadataCacheInstance } from "~/services/taskMetadataCacheInstance.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { syncDeclarativeSchedules } from "./createBackgroundWorker.server";
import { ExecuteTasksWaitingForDeployService } from "./executeTasksWaitingForDeploy";
import { compareDeploymentVersions } from "../utils/deploymentVersions";

export type ChangeCurrentDeploymentDirection = "promote" | "rollback";

export class ChangeCurrentDeploymentService extends BaseService {
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
    deployment: WorkerDeployment,
    direction: ChangeCurrentDeploymentDirection,
    disableVersionCheck?: boolean
  ) {
    if (!deployment.workerId) {
      throw new ServiceValidationError(
        direction === "promote"
          ? "Deployment is not associated with a worker and cannot be promoted."
          : "Deployment is not associated with a worker and cannot be rolled back."
      );
    }

    if (deployment.status !== "DEPLOYED") {
      throw new ServiceValidationError(
        direction === "promote"
          ? "Deployment must be in the DEPLOYED state to be promoted."
          : "Deployment must be in the DEPLOYED state to be rolled back."
      );
    }

    const currentPromotion = await this._prisma.workerDeploymentPromotion.findFirst({
      where: {
        environmentId: deployment.environmentId,
        label: CURRENT_DEPLOYMENT_LABEL,
      },
      select: {
        deployment: {
          select: { id: true, version: true },
        },
      },
    });

    if (currentPromotion) {
      if (currentPromotion.deployment.id === deployment.id) {
        throw new ServiceValidationError("Deployment is already the current deployment.");
      }

      // if there is a current promotion, we have to validate we are moving in the right direction based on the deployment versions
      if (!disableVersionCheck) {
        switch (direction) {
          case "promote": {
            if (
              compareDeploymentVersions(currentPromotion.deployment.version, deployment.version) >=
              0
            ) {
              throw new ServiceValidationError(
                "Cannot promote a deployment that is older than the current deployment."
              );
            }
            break;
          }
          case "rollback": {
            if (
              compareDeploymentVersions(currentPromotion.deployment.version, deployment.version) <=
              0
            ) {
              throw new ServiceValidationError(
                "Cannot rollback to a deployment that is newer than the current deployment."
              );
            }
            break;
          }
        }
      }
    }

    //set this deployment as the current deployment for this environment
    await this._prisma.workerDeploymentPromotion.upsert({
      where: {
        environmentId_label: {
          environmentId: deployment.environmentId,
          label: CURRENT_DEPLOYMENT_LABEL,
        },
      },
      create: {
        deploymentId: deployment.id,
        environmentId: deployment.environmentId,
        label: CURRENT_DEPLOYMENT_LABEL,
      },
      update: {
        deploymentId: deployment.id,
      },
    });

    const [fetchTasksError, tasks] = await tryCatch(
      this._prisma.backgroundWorkerTask.findMany({
        where: { workerId: deployment.workerId! },
        select: {
          slug: true,
          triggerSource: true,
          ttl: true,
          queue: { select: { id: true, name: true } },
        },
      })
    );

    if (fetchTasksError) {
      logger.error("Error fetching worker tasks on deployment change", {
        error: fetchTasksError,
      });
    }

    if (tasks) {
      // Side effect 1: refresh the `TaskIdentifier` table and the existing
      // `tids:` Redis cache so the task-listing UI reflects the new deploy.
      const [syncIdentifiersError] = await tryCatch(
        syncTaskIdentifiers(
          deployment.environmentId,
          deployment.projectId,
          deployment.workerId!,
          tasks.map((t) => ({ id: t.slug, triggerSource: t.triggerSource }))
        )
      );

      if (syncIdentifiersError) {
        logger.error("Error syncing task identifiers on deployment change", {
          error: syncIdentifiersError,
        });
      }

      // Side effect 2: refresh the `task-meta:` cache that the queue resolver
      // reads from. Independent of side effect 1 — if `syncTaskIdentifiers`
      // throws, the queue resolver still gets a warm cache for the new worker.
      const metadataEntries: TaskMetadataEntry[] = tasks.map((t) => ({
        slug: t.slug,
        ttl: t.ttl,
        triggerSource: t.triggerSource,
        queueId: t.queue?.id ?? null,
        queueName: t.queue?.name ?? "",
      }));

      // Cache calls log+swallow internally.
      await this._taskMetaCache.populateByCurrentWorker(
        deployment.environmentId,
        deployment.workerId!,
        metadataEntries
      );
    }

    const [scheduleSyncError] = await tryCatch(this.#syncSchedulesForDeployment(deployment));

    if (scheduleSyncError) {
      logger.error("Error syncing declarative schedules on deployment change", {
        error: scheduleSyncError,
      });
    }

    await ExecuteTasksWaitingForDeployService.enqueue(deployment.workerId);
  }

  async #syncSchedulesForDeployment(deployment: WorkerDeployment) {
    const worker = await this._prisma.backgroundWorker.findFirst({
      where: { id: deployment.workerId! },
    });

    if (!worker) {
      logger.error("Worker not found for deployment schedule sync", {
        deploymentId: deployment.id,
        workerId: deployment.workerId,
      });
      return;
    }

    const parsed = BackgroundWorkerMetadata.safeParse(worker.metadata);

    if (!parsed.success) {
      logger.error("Failed to parse worker metadata for schedule sync", {
        deploymentId: deployment.id,
        workerId: deployment.workerId,
        error: parsed.error,
      });
      return;
    }

    const environment = await this._prisma.runtimeEnvironment.findFirst({
      where: { id: deployment.environmentId },
      include: {
        project: true,
        organization: true,
        orgMember: true,
      },
    });

    if (!environment) {
      logger.error("Environment not found for deployment schedule sync", {
        deploymentId: deployment.id,
        environmentId: deployment.environmentId,
      });
      return;
    }

    await syncDeclarativeSchedules(parsed.data.tasks, worker, environment, this._prisma);
  }
}
