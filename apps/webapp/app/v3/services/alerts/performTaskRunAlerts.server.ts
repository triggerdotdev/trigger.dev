import { type Prisma, type ProjectAlertChannel } from "@trigger.dev/database";
import { $transaction, type PrismaClientOrTransaction, type prisma } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
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
        runtimeEnvironment: true,
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
          has: run.runtimeEnvironment.type,
        },
        enabled: true,
      },
    });

    for (const alertChannel of alertChannels) {
      await this.#createAndSendAlert(alertChannel, run);
    }
  }

  async #createAndSendAlert(alertChannel: ProjectAlertChannel, run: FoundRun) {
    await $transaction(this._prisma, "create and send run alert", async (tx) => {
      const alert = await this._prisma.projectAlert.create({
        data: {
          friendlyId: generateFriendlyId("alert"),
          channelId: alertChannel.id,
          projectId: run.projectId,
          environmentId: run.runtimeEnvironmentId,
          status: "PENDING",
          type: "TASK_RUN",
          taskRunId: run.id,
        },
      });

      await DeliverAlertService.enqueue(alert.id, tx);
    });
  }

  static async enqueue(runId: string, tx: PrismaClientOrTransaction, runAt?: Date) {
    return await workerQueue.enqueue(
      "v3.performTaskRunAlerts",
      {
        runId,
      },
      {
        tx,
        runAt,
        jobKey: `performTaskRunAlerts:${runId}`,
      }
    );
  }
}
