import { logger } from "~/services/logger.server";
import { BaseService } from "./baseService.server";
import { workerQueue } from "~/services/worker.server";
import { PerformDeploymentAlertsService } from "./alerts/performDeploymentAlerts.server";
import { PrismaClientOrTransaction } from "~/db.server";

export class TimeoutDeploymentService extends BaseService {
  public async call(id: string, fromStatus: string, errorMessage: string) {
    const deployment = await this._prisma.workerDeployment.findFirst({
      where: {
        id,
      },
      include: {
        environment: true,
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

    await this._prisma.workerDeployment.update({
      where: {
        id: deployment.id,
      },
      data: {
        status: "TIMED_OUT",
        failedAt: new Date(),
        errorData: { message: errorMessage, name: "TimeoutError" },
      },
    });

    await PerformDeploymentAlertsService.enqueue(deployment.id);
  }

  static async enqueue(
    deploymentId: string,
    fromStatus: string,
    errorMessage: string,
    runAt: Date,
    tx?: PrismaClientOrTransaction
  ) {
    await workerQueue.enqueue(
      "v3.timeoutDeployment",
      {
        deploymentId,
        fromStatus,
        errorMessage,
      },
      {
        runAt,
        jobKey: `timeoutDeployment:${deploymentId}`,
        jobKeyMode: "replace",
        tx,
      }
    );
  }

  static async dequeue(deploymentId: string, tx?: PrismaClientOrTransaction) {
    await workerQueue.dequeue(`timeoutDeployment:${deploymentId}`, { tx });
  }
}
