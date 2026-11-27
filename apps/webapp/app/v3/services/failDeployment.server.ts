import { PerformDeploymentAlertsService } from "./alerts/performDeploymentAlerts.server";
import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";
import {
  boundedIn,
  type WorkerDeployment,
  type WorkerDeploymentStatus,
} from "@trigger.dev/database";
import { type FailDeploymentRequestBody } from "@trigger.dev/core/v3/schemas";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { DeploymentService } from "./deployment.server";
import { recordDeploymentFinished } from "./recordDeploymentFinished.server";

export const FINAL_DEPLOYMENT_STATUSES: WorkerDeploymentStatus[] = [
  "CANCELED",
  "DEPLOYED",
  "FAILED",
  "TIMED_OUT",
];

export class FailDeploymentService extends BaseService {
  public async call(
    authenticatedEnv: AuthenticatedEnvironment,
    friendlyId: string,
    params: FailDeploymentRequestBody
  ) {
    const deployment = await this._prisma.workerDeployment.findFirst({
      where: {
        friendlyId,
        environmentId: authenticatedEnv.id,
      },
    });

    if (!deployment) {
      logger.error("Worker deployment not found", { friendlyId });
      return;
    }

    if (FINAL_DEPLOYMENT_STATUSES.includes(deployment.status)) {
      logger.error("Worker deployment already in final state", {
        id: deployment.id,
        friendlyId,
        status: deployment.status,
      });
      return;
    }

    const failedAt = new Date();

    // Guarded: a concurrent terminal transition can win after the check above
    const { count: updatedCount } = await this._prisma.workerDeployment.updateMany({
      where: {
        id: deployment.id,
        status: { notIn: boundedIn(FINAL_DEPLOYMENT_STATUSES) },
      },
      data: {
        status: "FAILED",
        failedAt,
        errorData: params.error,
      },
    });

    if (updatedCount === 0) {
      logger.warn("Worker deployment reached a final state concurrently, skipping fail", {
        id: deployment.id,
        friendlyId,
      });
      return;
    }

    // Re-read: the row can gain phase timestamps between the read and the guarded write
    const failedDeployment = await this._prisma.workerDeployment.findFirst({
      where: { id: deployment.id },
    });

    if (!failedDeployment) {
      logger.error("Worker deployment disappeared after fail transition", {
        id: deployment.id,
        friendlyId,
      });
      return;
    }

    await announceDeploymentFailure(authenticatedEnv, failedDeployment, params.error.message);

    return failedDeployment;
  }
}

export async function announceDeploymentFailure(
  environment: AuthenticatedEnvironment,
  deployment: WorkerDeployment,
  message: string
) {
  recordDeploymentFinished({
    status: "FAILED",
    deployment,
    environment: {
      organizationId: environment.organizationId,
      organizationSlug: environment.organization.slug,
      projectId: environment.projectId,
      projectName: environment.project.name,
      projectRef: environment.project.externalRef,
      environmentId: environment.id,
      environmentType: environment.type,
    },
    reason: message,
  });

  await new DeploymentService()
    .appendToEventLog(environment.project, deployment, [
      { type: "finalized", data: { result: "failed", message } },
    ])
    .orTee((error) => {
      logger.error("Failed to append failed deployment event to event log", { error });
    });

  try {
    await PerformDeploymentAlertsService.enqueue(deployment.id);
  } catch (error) {
    logger.error("Failed to enqueue deployment failure alerts", {
      error,
      deploymentId: deployment.id,
    });
  }
}
