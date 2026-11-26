import type { FinalizeDeploymentRequestBody } from "@trigger.dev/core/v3/schemas";
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
import { recordDeploymentFinished } from "./recordDeploymentFinished.server";
import { engine } from "../runEngine.server";
import { tryCatch } from "@trigger.dev/core";
import { externalDeploymentCacheInstance } from "~/services/externalDeploymentCacheInstance.server";
import type { PrismaClientOrTransaction } from "~/db.server";
import { queueDeploymentCheck } from "../deploymentChecksWorker.server";
import { gateDeployment, type DeploymentGateResult } from "../deploymentChecks.server";
import { computeOnlyEnabled, loadOrgFeatureFlags } from "~/v3/computeOnlyFlag.server";

const COMPUTE_ONLY_MISSING_TEMPLATE_MESSAGE =
  "This deploy couldn't be completed. Try deploying again, or contact support if it keeps failing.";

export class FinalizeDeploymentService extends BaseService {
  constructor(
    prisma?: PrismaClientOrTransaction,
    private readonly queueCheck: (deploymentId: string) => Promise<void> = queueDeploymentCheck,
    private readonly gate: typeof gateDeployment = gateDeployment
  ) {
    super(prisma);
  }

  public async call(
    authenticatedEnv: AuthenticatedEnvironment,
    id: string,
    body: FinalizeDeploymentRequestBody,
    /**
     * The org's `featureFlags` read from the primary, when the caller already did. Not the
     * authenticated env's copy, which comes from a replica that can miss a just-set `computeOnly`.
     */
    primaryOrgFeatureFlags?: unknown,
    /**
     * The finalize-time result, when the caller already ran it. Left out, it runs here.
     */
    gated?: DeploymentGateResult
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

    const orgFeatureFlags =
      primaryOrgFeatureFlags === undefined
        ? await loadOrgFeatureFlags(this._prisma, authenticatedEnv.organizationId)
        : primaryOrgFeatureFlags;

    // Sandbox tasks and compute-only orgs run only on microVMs, so a deployment without a
    // template cannot serve them.
    const sandboxTask = deployment.worker.tasks.find((task) => task.executionMode === "SANDBOX");
    if (!deployment.templateKey && (sandboxTask || computeOnlyEnabled(orgFeatureFlags))) {
      const error = sandboxTask
        ? {
            name: "MissingComputeTemplate",
            message: `Sandbox task "${sandboxTask.slug}" needs microVM compute, but this deployment has no compute template.`,
          }
        : { name: "DeploymentFailed", message: COMPUTE_ONLY_MISSING_TEMPLATE_MESSAGE };
      if (!sandboxTask) {
        // The reason stays in the log: the user only learns what to do next.
        logger.warn("Finalize refused: compute-only org's deployment has no template", {
          organizationId: authenticatedEnv.organizationId,
          deploymentId: deployment.id,
        });
      }
      await new FailDeploymentService(this._prisma).call(authenticatedEnv, deployment.friendlyId, {
        error,
      });
      throw new ServiceValidationError(error.message);
    }

    // The finalize-time step, on every route.
    const gate =
      gated ??
      (await this.gate(
        {
          id: deployment.id,
          friendlyId: deployment.friendlyId,
          imageReference: deployment.imageReference,
          type: deployment.type,
          organizationId: authenticatedEnv.organizationId,
          projectRef: authenticatedEnv.project.externalRef,
        },
        body.imageDigest
      ));
    if (gate.kind === "refuse") {
      await failRefusedDeployment(
        this._prisma,
        authenticatedEnv,
        deployment.friendlyId,
        gate.error
      );
    }

    // Use the resolved digest when there is one.
    const imageDigest =
      gate.kind === "proceed" && gate.checked
        ? gate.imageDigest
        : validatedImageDigest(body.imageDigest);
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
      },
    });

    if (updatedCount === 0) {
      logger.warn("Worker deployment left DEPLOYING concurrently, skipping finalize", {
        id: deployment.id,
      });
      throw new ServiceValidationError("Worker deployment is not in DEPLOYING status");
    }

    // Queue the follow-up check unless it already ran.
    if (!(gate.kind === "proceed" && gate.checked)) void this.queueCheck(deployment.id);

    const finalizedDeployment = {
      ...deployment,
      status: "DEPLOYED" as const,
      deployedAt,
      imageReference,
    };

    recordDeploymentFinished({
      status: "DEPLOYED",
      deployment: finalizedDeployment,
      environment: {
        organizationId: authenticatedEnv.organizationId,
        organizationSlug: authenticatedEnv.organization.slug,
        projectId: authenticatedEnv.projectId,
        projectName: authenticatedEnv.project.name,
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
      const promotionService = new ChangeCurrentDeploymentService(this._prisma);

      await promotionService.call(finalizedDeployment, "promote", {
        organizationFeatureFlags: orgFeatureFlags,
      });
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

/** Fails a refused deployment with its generic message, and throws it for the client. */
export async function failRefusedDeployment(
  prisma: PrismaClientOrTransaction,
  authenticatedEnv: AuthenticatedEnvironment,
  deploymentFriendlyId: string,
  error: { name: string; message: string }
): Promise<never> {
  await new FailDeploymentService(prisma).call(authenticatedEnv, deploymentFriendlyId, { error });
  throw new ServiceValidationError(error.message);
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
