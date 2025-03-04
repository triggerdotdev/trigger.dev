import { ProjectAlertChannel, ProjectAlertType, WorkerDeployment } from "@trigger.dev/database";
import { $transaction, PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import { BaseService } from "../baseService.server";
import { DeliverAlertService } from "./deliverAlert.server";
import { commonWorker } from "~/v3/commonWorker.server";

export class PerformDeploymentAlertsService extends BaseService {
  public async call(deploymentId: string) {
    const deployment = await this._prisma.workerDeployment.findFirst({
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
    await DeliverAlertService.createAndSendAlert(
      {
        channelId: alertChannel.id,
        channelType: alertChannel.type,
        projectId: deployment.projectId,
        environmentId: deployment.environmentId,
        alertType,
        deploymentId: deployment.id,
      },
      this._prisma
    );
  }

  static async enqueue(deploymentId: string, runAt?: Date) {
    return await commonWorker.enqueue({
      id: `performDeploymentAlerts:${deploymentId}`,
      job: "v3.performDeploymentAlerts",
      payload: { deploymentId },
      availableAt: runAt,
    });
  }
}
