import { conditionallyImportPacket, parsePacket } from "@trigger.dev/core/v3";
import { Prisma, TaskRun } from "@trigger.dev/database";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { BaseService } from "./baseService.server";
import { TriggerTaskService } from "./triggerTask.server";

type ExtendedTaskRunAttempt = Prisma.TaskRunAttemptGetPayload<{
  include: {
    runtimeEnvironment: true;
    backgroundWorker: true;
  };
}>;

export class ReplayTaskRunService extends BaseService {
  public async call(existingTaskRun: TaskRun) {
    const authenticatedEnvironment = await findEnvironmentById(
      existingTaskRun.runtimeEnvironmentId
    );
    if (!authenticatedEnvironment) {
      return;
    }

    logger.info("Replaying task run", {
      taskRunId: existingTaskRun.id,
      taskRunFriendlyId: existingTaskRun.friendlyId,
    });

    const payloadPacket = await conditionallyImportPacket({
      data: existingTaskRun.payload,
      dataType: existingTaskRun.payloadType,
    });
    const parsedPayload = await parsePacket(payloadPacket);

    logger.info("Replaying task run payload", {
      taskRunId: existingTaskRun.id,
      taskRunFriendlyId: existingTaskRun.friendlyId,
      payloadPacketType: payloadPacket.dataType,
    });

    const triggerTaskService = new TriggerTaskService();
    return await triggerTaskService.call(
      existingTaskRun.taskIdentifier,
      authenticatedEnvironment,
      {
        payload: parsedPayload,
        options: {
          queue: {
            name: existingTaskRun.queue,
          },
          concurrencyKey: existingTaskRun.concurrencyKey ?? undefined,
          test: existingTaskRun.isTest,
        },
      },
      {
        idempotencyKey: existingTaskRun.idempotencyKey,
      }
    );
  }
}
