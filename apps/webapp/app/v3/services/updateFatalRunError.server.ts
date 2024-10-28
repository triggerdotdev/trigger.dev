import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";
import { isFatalRunStatus } from "../taskStatus";
import { TaskRunErrorCodes, TaskRunInternalError } from "@trigger.dev/core/v3";
import { FinalizeTaskRunService } from "./finalizeTaskRun.server";

export type UpdateFatalRunErrorServiceOptions = {
  reason?: string;
  exitCode?: number;
  logs?: string;
  errorCode?: TaskRunInternalError["code"];
};

export class UpdateFatalRunErrorService extends BaseService {
  public async call(runId: string, options?: UpdateFatalRunErrorServiceOptions) {
    const opts = {
      reason: "Worker crashed",
      ...options,
    };

    logger.debug("UpdateFatalRunErrorService.call", { runId, opts });

    const taskRun = await this._prisma.taskRun.findFirst({
      where: {
        id: runId,
      },
    });

    if (!taskRun) {
      logger.error("[UpdateFatalRunErrorService] Task run not found", { runId });
      return;
    }

    if (!isFatalRunStatus(taskRun.status)) {
      logger.warn("[UpdateFatalRunErrorService] Task run is not in a fatal state", {
        runId,
        status: taskRun.status,
      });

      return;
    }

    logger.debug("[UpdateFatalRunErrorService] Updating crash error", { runId, options });

    const finalizeService = new FinalizeTaskRunService();
    await finalizeService.call({
      id: taskRun.id,
      status: "CRASHED",
      error: {
        type: "INTERNAL_ERROR",
        code: opts.errorCode ?? TaskRunErrorCodes.TASK_RUN_CRASHED,
        message: opts.reason,
        stackTrace: opts.logs,
      },
    });
  }
}
