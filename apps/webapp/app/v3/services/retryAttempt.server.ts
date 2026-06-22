import { logger } from "~/services/logger.server";
import { commonWorker } from "../commonWorker.server";
import { socketIo } from "../handleSocketIo.server";
import { BaseService } from "./baseService.server";
import { isV3Disabled } from "../engineDeprecation.server";

export class RetryAttemptService extends BaseService {
  public async call(runId: string) {
    const taskRun = await this.runStore.findRun({ id: runId }, this._prisma);

    if (!taskRun) {
      logger.error("Task run not found", { runId });
      return;
    }

    // v3 (engine V1) shutdown: don't retry abandoned V1 runs. v4 is unaffected.
    if (isV3Disabled() && taskRun.engine === "V1") {
      logger.debug("[RetryAttemptService] Skipping retry for shut-down v3 run", { runId });
      return;
    }

    socketIo.coordinatorNamespace.emit("READY_FOR_RETRY", {
      version: "v1",
      runId,
    });
  }

  static async enqueue(runId: string, runAt?: Date) {
    return await commonWorker.enqueue({
      id: `retryAttempt:${runId}`,
      job: "v3.retryAttempt",
      payload: {
        runId,
      },
      availableAt: runAt,
    });
  }
}
