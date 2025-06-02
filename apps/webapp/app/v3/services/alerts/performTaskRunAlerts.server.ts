import { type Prisma, type ProjectAlertChannel } from "@trigger.dev/database";
import { type prisma } from "~/db.server";
import { commonWorker } from "~/v3/commonWorker.server";
import { BaseService } from "../baseService.server";
import { DeliverAlertService } from "./deliverAlert.server";

type FoundRun = Prisma.Result<
  typeof prisma.taskRun,
  { include: { lockedBy: true; runtimeEnvironment: true } },
  "findUniqueOrThrow"
>;

export class PerformTaskRunAlertsService extends BaseService {
  public async call(runId: string) {
    const run = await this._prisma.taskRun.findFirst({
      where: { id: runId },
      include: {
        lockedBy: true,
        runtimeEnvironment: {
          include: {
            parentEnvironment: true,
          },
        },
      },
    });

    if (!run) {
      return;
    }

    // Find all the alert channels
    const alertChannels = await this._prisma.projectAlertChannel.findMany({
      where: {
        projectId: run.projectId,
        alertTypes: {
          has: "TASK_RUN",
        },
        environmentTypes: {
          has: run.runtimeEnvironment.parentEnvironment?.type ?? run.runtimeEnvironment.type,
        },
        enabled: true,
      },
    });

    for (const alertChannel of alertChannels) {
      await this.#createAndSendAlert(alertChannel, run);
    }
  }

  async #createAndSendAlert(alertChannel: ProjectAlertChannel, run: FoundRun) {
    await DeliverAlertService.createAndSendAlert(
      {
        channelId: alertChannel.id,
        channelType: alertChannel.type,
        projectId: run.projectId,
        environmentId: run.runtimeEnvironmentId,
        alertType: "TASK_RUN",
        taskRunId: run.id,
      },
      this._prisma
    );
  }

  static async enqueue(runId: string, runAt?: Date) {
    return await commonWorker.enqueue({
      id: `performTaskRunAlerts:${runId}`,
      job: "v3.performTaskRunAlerts",
      payload: { runId },
      availableAt: runAt,
    });
  }
}
