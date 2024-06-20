import { PrismaClientOrTransaction } from "~/db.server";
import { BaseService } from "./baseService.server";
import { workerQueue } from "~/services/worker.server";
import { RegisterNextTaskScheduleInstanceService } from "./registerNextTaskScheduleInstance.server";
import { TriggerTaskService } from "./triggerTask.server";
import { stringifyIO } from "@trigger.dev/core/v3";
import { nextScheduledTimestamps } from "../utils/calculateNextSchedule.server";
import { findCurrentWorkerDeployment } from "../models/workerDeployment.server";
import { logger } from "~/services/logger.server";

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

    if (instance.environment.type !== "DEVELOPMENT") {
      // Get the current backgroundWorker for this environment
      const currentWorkerDeployment = await findCurrentWorkerDeployment(instance.environment.id);

      if (!currentWorkerDeployment) {
        logger.debug("No current worker deployment found, skipping task trigger", {
          instanceId,
          scheduleId: instance.taskSchedule.friendlyId,
          environmentId: instance.environment.id,
        });

        shouldTrigger = false;
      } else if (
        !currentWorkerDeployment.worker ||
        !currentWorkerDeployment.worker.tasks.some(
          (t) => t.slug === instance.taskSchedule.taskIdentifier
        )
      ) {
        logger.debug(
          "Current worker deployment does not contain the scheduled task identifier, skipping task trigger",
          {
            instanceId,
            scheduleId: instance.taskSchedule.friendlyId,
            environmentId: instance.environment.id,
            workerDeploymentId: currentWorkerDeployment.id,
            workerId: currentWorkerDeployment.worker?.id,
            taskIdentifier: instance.taskSchedule.taskIdentifier,
          }
        );

        shouldTrigger = false;
      }
    }

    const registerNextService = new RegisterNextTaskScheduleInstanceService();

    if (shouldTrigger) {
      // Enqueue triggering the task
      const triggerTask = new TriggerTaskService();

      const payload = {
        scheduleId: instance.taskSchedule.friendlyId,
        timestamp: instance.nextScheduledTimestamp,
        lastTimestamp: instance.lastScheduledTimestamp ?? undefined,
        externalId: instance.taskSchedule.externalId ?? undefined,
        timezone: instance.taskSchedule.timezone,
        upcoming: nextScheduledTimestamps(
          instance.taskSchedule.generatorExpression,
          instance.taskSchedule.timezone,
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
        { payload: payloadPacket.data, options: { payloadType: payloadPacket.dataType } },
        { customIcon: "scheduled" }
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
