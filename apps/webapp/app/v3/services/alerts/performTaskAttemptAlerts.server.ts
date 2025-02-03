import { Prisma, ProjectAlertChannel } from "@trigger.dev/database";
import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import { BaseService } from "../baseService.server";
import { DeliverAlertService } from "./deliverAlert.server";

type FoundTaskAttempt = Prisma.Result<
  typeof prisma.taskRunAttempt,
  { include: { taskRun: true; backgroundWorkerTask: true; runtimeEnvironment: true } },
  "findUniqueOrThrow"
>;

export class PerformTaskAttemptAlertsService extends BaseService {
  public async call(attemptId: string) {
    const taskAttempt = await this._prisma.taskRunAttempt.findFirst({
      where: { id: attemptId },
      include: {
        taskRun: true,
        backgroundWorkerTask: true,
        runtimeEnvironment: true,
      },
    });

    if (!taskAttempt) {
      return;
    }

    // Find all the alert channels
    const alertChannels = await this._prisma.projectAlertChannel.findMany({
      where: {
        projectId: taskAttempt.taskRun.projectId,
        alertTypes: {
          has: "TASK_RUN_ATTEMPT",
        },
        environmentTypes: {
          has: taskAttempt.runtimeEnvironment.type,
        },
        enabled: true,
      },
    });

    for (const alertChannel of alertChannels) {
      await this.#createAndSendAlert(alertChannel, taskAttempt);
    }
  }

  async #createAndSendAlert(alertChannel: ProjectAlertChannel, taskAttempt: FoundTaskAttempt) {
    await $transaction(this._prisma, "create and send attempt alert", async (tx) => {
      const alert = await this._prisma.projectAlert.create({
        data: {
          friendlyId: generateFriendlyId("alert"),
          channelId: alertChannel.id,
          projectId: taskAttempt.taskRun.projectId,
          environmentId: taskAttempt.runtimeEnvironmentId,
          status: "PENDING",
          type: "TASK_RUN_ATTEMPT",
          taskRunAttemptId: taskAttempt.id,
        },
      });

      await DeliverAlertService.enqueue(alert.id, tx);
    });
  }

  static async enqueue(attemptId: string, tx: PrismaClientOrTransaction, runAt?: Date) {
    return await workerQueue.enqueue(
      "v3.performTaskAttemptAlerts",
      {
        attemptId,
      },
      {
        tx,
        runAt,
        jobKey: `performTaskAttemptAlerts:${attemptId}`,
      }
    );
  }
}
