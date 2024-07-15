import { type TaskRun } from "@trigger.dev/database";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { type RescheduleRunRequestBody } from '@trigger.dev/core/v3/schemas';
import { parseDelay } from "./triggerTask.server";
import { $transaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";

export class RescheduleTaskRunService extends BaseService {
  public async call(taskRun: TaskRun, body: RescheduleRunRequestBody) {
    if (taskRun.status !== "DELAYED") {
      throw new ServiceValidationError("Cannot reschedule a run that is not delayed");
    }

    const delay = await parseDelay(body.delay);

    if (!delay) {
      throw new ServiceValidationError(`Invalid delay: ${body.delay}`);
    }

    return await $transaction(this._prisma, async (tx) => {
      const updatedRun = await tx.taskRun.update({
        where: {
          id: taskRun.id,
        },
        data: {
          delayUntil: delay,
        },
      });

      await workerQueue.enqueue(
        "v3.enqueueDelayedRun",
        { runId: taskRun.id },
        { tx, runAt: delay, jobKey: `v3.enqueueDelayedRun.${taskRun.id}` }
      );

      return updatedRun;
    });
  }
}
