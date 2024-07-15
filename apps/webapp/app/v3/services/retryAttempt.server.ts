import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";
import { socketIo } from "../handleSocketIo.server";
import { type PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";

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

  static async enqueue(runId: string, tx: PrismaClientOrTransaction, runAt?: Date) {
    return await workerQueue.enqueue(
      "v3.retryAttempt",
      {
        runId,
      },
      {
        tx,
        runAt,
        jobKey: `retryAttempt:${runId}`,
      }
    );
  }
}
