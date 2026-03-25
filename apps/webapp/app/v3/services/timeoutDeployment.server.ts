import { logger } from "~/services/logger.server";
import { BaseService } from "./baseService.server";
import { commonWorker } from "../commonWorker.server";
import { PerformDeploymentAlertsService } from "./alerts/performDeploymentAlerts.server";
import { type PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { DeploymentService } from "./deployment.server";

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
          },
        },
      },
    });

    if (!deployment) {
      logger.error(`No worker deployment with this ID: ${id}`);
      return;
    }

    if (deployment.status !== fromStatus) {
      logger.error("Deployment is not in the correct state to be timed out", {
        currentStatus: deployment.status,
        fromStatus,
      });
      return;
    }

    const timedOutDeployment = await this._prisma.workerDeployment.update({
      where: {
        id: deployment.id,
      },
      data: {
        status: "TIMED_OUT",
        failedAt: new Date(),
        errorData: { message: errorMessage, name: "TimeoutError" },
      },
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
    // For backwards compatibility during transition, we need to dequeue/ack from both workers
    await workerQueue.dequeue(`timeoutDeployment:${deploymentId}`, { tx });
    await commonWorker.ack(`timeoutDeployment:${deploymentId}`);
  }
}
