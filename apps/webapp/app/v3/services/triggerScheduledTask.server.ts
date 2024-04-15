import { PrismaClientOrTransaction } from "~/db.server";
import { BaseService } from "./baseService.server";
import { workerQueue } from "~/services/worker.server";
import { RegisterNextTaskScheduleInstanceService } from "./registerNextTaskScheduleInstance.server";
import { TriggerTaskService } from "./triggerTask.server";
import { logger, stringifyIO } from "@trigger.dev/core/v3";

export class TriggerScheduledTaskService extends BaseService {
  public async call(instanceId: string) {
    const instance = await this._prisma.taskScheduleInstance.findUnique({
      where: {
        id: instanceId,
      },
      include: {
        taskSchedule: true,
        environment: {
          include: {
            project: true,
            organization: true,
            currentSession: true,
          },
        },
      },
    });

    if (!instance) {
      return;
    }

    let shouldTrigger = true;

    if (!instance.active) {
      shouldTrigger = false;
    }

    if (!instance.taskSchedule.active) {
      shouldTrigger = false;
    }

    if (!instance.nextScheduledTimestamp) {
      shouldTrigger = false;
    }

    if (
      instance.environment.type === "DEVELOPMENT" &&
      (!instance.environment.currentSession || instance.environment.currentSession.disconnectedAt)
    ) {
      shouldTrigger = false;
    }

    const registerNextService = new RegisterNextTaskScheduleInstanceService();

    if (shouldTrigger) {
      // Enqueue triggering the task
      const triggerTask = new TriggerTaskService();

      const payload = {
        scheduleId: instance.taskSchedule.friendlyId,
        timestamp: instance.nextScheduledTimestamp,
        lastTimestamp: instance.lastScheduledTimestamp,
        externalId: instance.taskSchedule.externalId,
        upcoming: registerNextService.nextScheduledTimestamps(
          instance.taskSchedule.cron,
          instance.nextScheduledTimestamp!,
          10
        ),
      };

      const payloadPacket = await stringifyIO(payload);

      logger.debug("Triggering scheduled task", {
        instance,
        payloadPacket,
      });

      const run = await triggerTask.call(
        instance.taskSchedule.taskIdentifier,
        instance.environment,
        { payload: payloadPacket.data, options: { payloadType: payloadPacket.dataType } }
      );

      if (!run) {
        logger.error("Failed to trigger task", {
          instanceId,
          scheduleId: instance.taskSchedule.friendlyId,
          payloadPacket,
        });
      } else {
        await this._prisma.taskRun.update({
          where: {
            id: run.id,
          },
          data: {
            scheduleId: instance.taskSchedule.id,
            scheduleInstanceId: instance.id,
          },
        });
      }
    }

    await this._prisma.taskScheduleInstance.update({
      where: {
        id: instanceId,
      },
      data: {
        lastScheduledTimestamp: instance.nextScheduledTimestamp,
      },
    });

    await registerNextService.call(instanceId);
  }

  public static async enqueue(instanceId: string, runAt: Date, tx?: PrismaClientOrTransaction) {
    return await workerQueue.enqueue(
      "v3.triggerScheduledTask",
      { instanceId },
      { tx, jobKey: `scheduled-task-instance:${instanceId}`, runAt }
    );
  }
}
