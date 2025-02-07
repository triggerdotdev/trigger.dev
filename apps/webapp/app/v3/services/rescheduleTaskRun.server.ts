import { RescheduleRunRequestBody } from "@trigger.dev/core/v3";
import { TaskRun } from "@trigger.dev/database";
import { parseDelay } from "~/utils/delays";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { EnqueueDelayedRunService } from "./enqueueDelayedRun.server";

export class RescheduleTaskRunService extends BaseService {
  public async call(taskRun: TaskRun, body: RescheduleRunRequestBody) {
    if (taskRun.status !== "DELAYED") {
      throw new ServiceValidationError("Cannot reschedule a run that is not delayed");
    }

    const delay = await parseDelay(body.delay);

    if (!delay) {
      throw new ServiceValidationError(`Invalid delay: ${body.delay}`);
    }

    const updatedRun = await this._prisma.taskRun.update({
      where: {
        id: taskRun.id,
      },
      data: {
        delayUntil: delay,
      },
    });

    await EnqueueDelayedRunService.reschedule(taskRun.id, delay);

    return updatedRun;
  }
}
