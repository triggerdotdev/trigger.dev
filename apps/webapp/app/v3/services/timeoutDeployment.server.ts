import { Prisma } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { BaseService } from "./baseService.server";
import { commonWorker } from "../commonWorker.server";
import { PerformDeploymentAlertsService } from "./alerts/performDeploymentAlerts.server";
import { type PrismaClientOrTransaction } from "~/db.server";
import { DeploymentService } from "./deployment.server";
import { recordDeploymentFinished } from "./recordDeploymentFinished.server";

export class TimeoutDeploymentService extends BaseService {
  public async call(id: string, fromStatus: string, errorMessage: string) {
    const deployment = await this._prisma.workerDeployment.findFirst({
      where: {
        id,
      },
      include: {
        environment: {
          include: {
            project: true,
            organization: {
              select: { slug: true },
            },
          },
        },
      },
    });

    if (!deployment) {
      logger.error(`No worker deployment with this ID: ${id}`);
      return;
    }

    if (deployment.status !== fromStatus) {
      // Race: timeout job fired after the deployment moved out of the
      // expected state (already deployed/failed). System handles it by
      // returning early — not an error.
      logger.warn("Deployment is not in the correct state to be timed out", {
        currentStatus: deployment.status,
        fromStatus,
      });
      return;
    }

    const failedAt = new Date();
    const errorData = { message: errorMessage, name: "TimeoutError" };

    // Guarded: keeps the fromStatus check atomic with the write
    const { count: updatedCount } = await this._prisma.workerDeployment.updateMany({
      where: {
        id: deployment.id,
        status: deployment.status,
      },
      data: {
        status: "TIMED_OUT",
        failedAt,
        errorData,
        buildEnvVars: Prisma.DbNull,
      },
    });

    if (updatedCount === 0) {
      logger.warn("Deployment moved out of the expected state concurrently, skipping timeout", {
        id: deployment.id,
        fromStatus,
      });
      return;
    }

    const timedOutDeployment = {
      ...deployment,
      status: "TIMED_OUT" as const,
      failedAt,
      errorData,
      buildEnvVars: null,
    };

    recordDeploymentFinished({
      status: "TIMED_OUT",
      deployment: timedOutDeployment,
      environment: {
        organizationId: deployment.environment.project.organizationId,
        organizationSlug: deployment.environment.organization.slug,
        projectId: deployment.environment.projectId,
        projectName: deployment.environment.project.name,
        projectRef: deployment.environment.project.externalRef,
        environmentId: deployment.environmentId,
        environmentType: deployment.environment.type,
      },
      reason: errorMessage,
    });

    const deploymentService = new DeploymentService();
    await deploymentService
      .appendToEventLog(deployment.environment.project, timedOutDeployment, [
        {
          type: "finalized",
          data: {
            result: "timed_out",
            message: errorMessage,
          },
        },
      ])
      .orTee((error) => {
        logger.error("Failed to append timed out deployment event to event log", { error });
      });

    await PerformDeploymentAlertsService.enqueue(deployment.id);
  }

  static async enqueue(
    deploymentId: string,
    fromStatus: string,
    errorMessage: string,
    runAt: Date
  ) {
    await commonWorker.enqueue({
      id: `timeoutDeployment:${deploymentId}`,
      job: "v3.timeoutDeployment",
      payload: {
        deploymentId,
        fromStatus,
        errorMessage,
      },
      availableAt: runAt,
    });
  }

  static async dequeue(deploymentId: string, tx?: PrismaClientOrTransaction) {
    await commonWorker.ack(`timeoutDeployment:${deploymentId}`);
  }
}
