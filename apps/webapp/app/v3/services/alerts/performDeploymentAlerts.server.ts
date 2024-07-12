import { type ProjectAlertChannel, type ProjectAlertType, type WorkerDeployment } from "@trigger.dev/database";
import { $transaction, type PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import { BaseService } from "../baseService.server";
import { DeliverAlertService } from "./deliverAlert.server";

export class PerformDeploymentAlertsService extends BaseService {
  public async call(deploymentId: string) {
    const deployment = await this._prisma.workerDeployment.findUnique({
      where: { id: deploymentId },
      include: {
        environment: true,
      },
    });

    if (!deployment) {
      return;
    }

    const alertType =
      deployment.status === "DEPLOYED" ? "DEPLOYMENT_SUCCESS" : "DEPLOYMENT_FAILURE";

    // Find all the alert channels
    const alertChannels = await this._prisma.projectAlertChannel.findMany({
      where: {
        projectId: deployment.projectId,
        alertTypes: {
          has: alertType,
        },
        environmentTypes: {
          has: deployment.environment.type,
        },
        enabled: true,
      },
    });

    for (const alertChannel of alertChannels) {
      await this.#createAndSendAlert(alertChannel, deployment, alertType);
    }
  }

  async #createAndSendAlert(
    alertChannel: ProjectAlertChannel,
    deployment: WorkerDeployment,
    alertType: ProjectAlertType
  ) {
    await $transaction(this._prisma, async (tx) => {
      const alert = await this._prisma.projectAlert.create({
        data: {
          friendlyId: generateFriendlyId("alert"),
          channelId: alertChannel.id,
          projectId: deployment.projectId,
          environmentId: deployment.environmentId,
          status: "PENDING",
          type: alertType,
          workerDeploymentId: deployment.id,
        },
      });

      await DeliverAlertService.enqueue(alert.id, tx);
    });
  }

  static async enqueue(deploymentId: string, tx: PrismaClientOrTransaction, runAt?: Date) {
    return await workerQueue.enqueue(
      "v3.performDeploymentAlerts",
      {
        deploymentId,
      },
      {
        tx,
        runAt,
        jobKey: `performDeploymentAlerts:${deploymentId}`,
      }
    );
  }
}
