import { BackgroundWorkerMetadata, tryCatch } from "@trigger.dev/core/v3";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import {
  isTransactionClient,
  type PrismaClientOrTransaction,
  type WorkerDeployment,
} from "@trigger.dev/database";
import { $transaction, webhookPrisma } from "~/db.server";
import { syncSkewProtectionThresholdSignal } from "~/services/realtime/skewProtectionThresholdSignal.server";
import { logger } from "~/services/logger.server";
import { syncTaskIdentifiers } from "~/services/taskIdentifierRegistry.server";
import {
  type TaskMetadataCache,
  parseExecutionPolicy,
  parseTaskGates,
  type TaskMetadataEntry,
} from "~/services/taskMetadataCache.server";
import { taskMetadataCacheInstance } from "~/services/taskMetadataCacheInstance.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { syncDeclarativeSchedules, syncDeclarativeWebhooks } from "./createBackgroundWorker.server";
import { compareDeploymentVersions } from "../utils/deploymentVersions";
import { computeOnlyEnabled } from "../computeOnlyFlag.server";
import {
  clearSkewProtectionThresholdsAbove,
  lockThresholdsAbove,
  type SkewProtectionThresholdsCleared,
} from "./skewProtectionThreshold.server";

export type ChangeCurrentDeploymentDirection = "promote" | "rollback";

/** A compute-only organization can't make a deployment without a compute template current. */
export const blockedForComputeOnly = (
  deployment: Pick<WorkerDeployment, "templateKey">,
  organizationFeatureFlags: unknown
) => !deployment.templateKey && computeOnlyEnabled(organizationFeatureFlags);

export type ChangeCurrentDeploymentOptions = {
  /** Skip the check that a promote moves forward and a rollback moves back. */
  disableVersionCheck?: boolean;
  /**
   * Who makes the change, recorded on the skew protection threshold history: a dashboard user, or
   * through the API, the key's name (see `apiKeyActorName`).
   */
  actor?: { userId: string } | { apiKeyName: string };
  /**
   * The organization's `featureFlags` when the caller already loaded them. Without them, a
   * deployment with no compute template costs one read to check the organization.
   */
  organizationFeatureFlags?: unknown;
  /** When set, the switch only happens if this is still the current deployment (null: none). */
  expectedCurrentDeploymentId?: string | null;
  /** When set, the switch only happens if it would clear exactly these thresholds. */
  expectedClearedThresholds?: SkewProtectionThresholdsCleared;
};

const THRESHOLDS_CHANGED = new Error("The skew protection thresholds changed since approval");

const clearedKey = (cleared: SkewProtectionThresholdsCleared) =>
  JSON.stringify({
    environment: cleared.environment?.version ?? null,
    tasks: [...cleared.tasks].sort((a, b) => a.task.localeCompare(b.task)),
  });

export type ChangeCurrentDeploymentResult = {
  /**
   * The skew protection thresholds this change cleared (the environment's and each task's),
   * because the new current version is below them.
   */
  skewProtectionThresholdsCleared?: SkewProtectionThresholdsCleared;
  /** Set when `expectedCurrentDeploymentId` no longer matched; nothing changed. */
  stale?: true;
};

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
    options: ChangeCurrentDeploymentOptions = {}
  ): Promise<ChangeCurrentDeploymentResult> {
    const {
      disableVersionCheck,
      actor,
      organizationFeatureFlags,
      expectedCurrentDeploymentId,
      expectedClearedThresholds,
    } = options;
    // On a caller's transaction a stale answer couldn't undo the pointer write, which would commit.
    if (expectedClearedThresholds !== undefined && isTransactionClient(this._prisma)) {
      throw new Error("expectedClearedThresholds needs the service to run its own transaction");
    }
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

    if (!deployment.templateKey) {
      await this.#assertServesComputeOnly(deployment, organizationFeatureFlags);
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

    if (
      expectedCurrentDeploymentId !== undefined &&
      (currentPromotion?.deployment.id ?? null) !== expectedCurrentDeploymentId
    ) {
      return { stale: true };
    }

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

    // Set this deployment as the current deployment for this environment, and in the same
    // transaction clear every skew protection threshold this deployment is below. With an
    // expected current deployment the switch is conditional on it.
    // Locks are taken pointer first, then the environment row, in every path.
    const switched = await $transaction(this._prisma, "changeCurrentDeployment", async (tx) => {
      if (expectedCurrentDeploymentId === undefined) {
        await tx.workerDeploymentPromotion.upsert({
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
      } else {
        const pointer = {
          environmentId: deployment.environmentId,
          label: CURRENT_DEPLOYMENT_LABEL,
        };
        const written =
          expectedCurrentDeploymentId === null
            ? await tx.workerDeploymentPromotion.createMany({
                data: [{ ...pointer, deploymentId: deployment.id }],
                skipDuplicates: true,
              })
            : await tx.workerDeploymentPromotion.updateMany({
                where: { ...pointer, deploymentId: expectedCurrentDeploymentId },
                data: { deploymentId: deployment.id },
              });
        if (written.count === 0) return { stale: true as const };
      }

      if (expectedClearedThresholds !== undefined) {
        const clearing = await lockThresholdsAbove(
          tx,
          deployment.environmentId,
          deployment.version
        );
        // Throwing rolls back the pointer write above.
        if (clearedKey(clearing) !== clearedKey(expectedClearedThresholds)) {
          throw THRESHOLDS_CHANGED;
        }
      }

      return {
        thresholdsCleared: await clearSkewProtectionThresholdsAbove(tx, {
          environmentId: deployment.environmentId,
          version: deployment.version,
          ...actor,
        }),
      };
    }).catch((error: unknown) => {
      if (error === THRESHOLDS_CHANGED) return { stale: true as const };
      throw error;
    });
    if (switched && "stale" in switched) return { stale: true };
    const thresholdsCleared = switched?.thresholdsCleared;

    // The signal says whether the current deployment's SDK can continue a turn, and carries the
    // thresholds the promote may have cleared. Not awaited: with S2 slow it would hold every
    // promote and deploy for seconds, and it never throws (a failure is logged).
    void syncSkewProtectionThresholdSignal(deployment.environmentId, {
      changed: thresholdsCleared !== undefined,
    });

    if (thresholdsCleared) {
      logger.info("Cleared skew protection thresholds: the new current deployment is below them", {
        environmentId: deployment.environmentId,
        deploymentId: deployment.id,
        version: deployment.version,
        threshold: thresholdsCleared.environment?.version,
        taskThresholds: thresholdsCleared.tasks.length,
      });
    }

    const [fetchTasksError, tasks] = await tryCatch(
      this._prisma.backgroundWorkerTask.findMany({
        where: { workerId: deployment.workerId! },
        select: {
          slug: true,
          triggerSource: true,
          executionPolicy: true,
          ttl: true,
          gates: true,
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
        executionPolicy: parseExecutionPolicy(t.executionPolicy),
        queueId: t.queue?.id ?? null,
        queueName: t.queue?.name ?? "",
        gates: parseTaskGates(t.gates),
      }));

      // Cache calls log+swallow internally.
      await this._taskMetaCache.populateByCurrentWorker(
        deployment.environmentId,
        deployment.workerId!,
        metadataEntries,
        deployment.templateKey
      );
    }

    const [declarativeSyncError] = await tryCatch(this.#syncDeclarativeResources(deployment));

    if (declarativeSyncError) {
      logger.error("Error syncing declarative resources on deployment change", {
        error: declarativeSyncError,
      });
    }

    return { skewProtectionThresholdsCleared: thresholdsCleared };
  }

  // A compute-only organization's runs can't start on a deployment without a compute template,
  // so making one current would leave every trigger of the environment failing.
  async #assertServesComputeOnly(deployment: WorkerDeployment, organizationFeatureFlags: unknown) {
    const flags =
      organizationFeatureFlags !== undefined
        ? organizationFeatureFlags
        : (
            await this._prisma.runtimeEnvironment.findFirst({
              where: { id: deployment.environmentId },
              select: { organization: { select: { featureFlags: true } } },
            })
          )?.organization.featureFlags;
    if (blockedForComputeOnly(deployment, flags)) {
      logger.warn("Refused to make a deployment without a template current (compute-only org)", {
        deploymentId: deployment.id,
        environmentId: deployment.environmentId,
        version: deployment.version,
      });
      throw new ServiceValidationError(
        `Version ${deployment.version} can't be made current. Deploy a new version instead.`
      );
    }
  }

  async #syncDeclarativeResources(deployment: WorkerDeployment) {
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

    const [schedulesError] = await tryCatch(
      syncDeclarativeSchedules(parsed.data.tasks, worker, environment, this._prisma)
    );

    if (schedulesError) {
      logger.error("Error syncing declarative schedules on deployment change", {
        deploymentId: deployment.id,
        error: schedulesError,
      });
    }

    const [webhooksError] = await tryCatch(
      syncDeclarativeWebhooks(
        {
          endpoints: parsed.data.webhookEndpoints,
          subscribers: parsed.data.webhookSubscribers,
        },
        worker,
        environment,
        this._prisma,
        webhookPrisma
      )
    );

    if (webhooksError) {
      logger.error("Error syncing declarative webhooks on deployment change", {
        deploymentId: deployment.id,
        error: webhooksError,
      });
    }
  }
}
