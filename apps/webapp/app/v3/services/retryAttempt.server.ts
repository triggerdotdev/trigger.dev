import { logger } from "~/services/logger.server";
import { commonWorker } from "../commonWorker.server";
import { socketIo } from "../handleSocketIo.server";
import { BaseService } from "./baseService.server";

export class RetryAttemptService extends BaseService {
  public async call(runId: string) {
    const taskRun = await this._prisma.taskRun.findFirst({
      where: {
        id: runId,
      },
    });

    if (!taskRun) {
      logger.error("Task run not found", { runId });
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
