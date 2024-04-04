import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";
import { CancelTaskRunService } from "./cancelTaskRun.server";

export type HandleWorkerCrashServiceOptions = {
  reason?: string;
  cancelAttempts?: boolean;
  crashedAt?: Date;
};

export class HandleWorkerCrashService extends BaseService {
  public async call(runId: string, options?: HandleWorkerCrashServiceOptions) {
    logger.debug("HandleWorkerCrashService.call()", { runId });

    const opts = {
      reason: "Worker crashed",
      cancelAttempts: true,
      crashedAt: new Date(),
      ...options,
    };

    const taskRun = await this._prisma.taskRun.findUnique({
      where: { id: runId },
    });

    if (!taskRun) {
      logger.error("Task run not found", { runId });
      return;
    }

    const cancelTaskRun = new CancelTaskRunService(this._prisma);

    try {
      await cancelTaskRun.call(taskRun, {
        reason: opts.reason,
        cancelAttempts: opts.cancelAttempts,
        cancelledAt: opts.crashedAt,
        hasCrashed: true,
      });
    } catch (error) {
      logger.error("Failed to cancel in progress run", {
        runId,
        error,
      });
    }
  }
}
