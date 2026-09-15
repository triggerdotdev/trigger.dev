import type { RescheduleRunRequestBody } from "@trigger.dev/core/v3";
import type { TaskRun } from "@trigger.dev/database";
import { parseDelay } from "~/utils/delays";
import { V3_TRIGGER_DEPRECATION_MESSAGE } from "../engineDeprecation.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { engine } from "../runEngine.server";

export class RescheduleTaskRunService extends BaseService {
  public async call(taskRun: TaskRun, body: RescheduleRunRequestBody) {
    // v3 (engine V1) is retired: reject rescheduling a legacy V1 delayed run
    // gracefully instead of enqueuing into the removed V1 worker.
    if (taskRun.engine === "V1") {
      throw new ServiceValidationError(V3_TRIGGER_DEPRECATION_MESSAGE);
    }

    if (taskRun.status !== "DELAYED") {
      throw new ServiceValidationError("Cannot reschedule a run that is not delayed");
    }

    const delay = await parseDelay(body.delay);

    if (!delay) {
      throw new ServiceValidationError(`Invalid delay: ${body.delay}`);
    }

    await this.runStore.rescheduleRun(
      taskRun.id,
      {
        delayUntil: delay,
        queueTimestamp: delay,
      },
      this._prisma
    );

    return engine.rescheduleDelayedRun({ runId: taskRun.id, delayUntil: delay });
  }
}
