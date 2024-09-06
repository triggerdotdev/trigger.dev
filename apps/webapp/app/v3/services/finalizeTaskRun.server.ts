import { sanitizeError, TaskRunError } from "@trigger.dev/core/v3";
import { type Prisma, type TaskRun } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";
import {
  isFailedRunStatus,
  type FINAL_ATTEMPT_STATUSES,
  type FINAL_RUN_STATUSES,
} from "../taskStatus";
import { PerformTaskRunAlertsService } from "./alerts/performTaskRunAlerts.server";
import { BaseService } from "./baseService.server";
import { ResumeDependentParentsService } from "./resumeDependentParents.server";

type BaseInput = {
  id: string;
  status?: FINAL_RUN_STATUSES;
  expiredAt?: Date;
  completedAt?: Date;
  attemptStatus?: FINAL_ATTEMPT_STATUSES;
  error?: TaskRunError;
};

type InputWithInclude<T extends Prisma.TaskRunInclude> = BaseInput & {
  include: T;
};

type InputWithoutInclude = BaseInput & {
  include?: undefined;
};

type Output<T extends Prisma.TaskRunInclude | undefined> = T extends Prisma.TaskRunInclude
  ? Prisma.TaskRunGetPayload<{ include: T }>
  : TaskRun;

export class FinalizeTaskRunService extends BaseService {
  public async call<T extends Prisma.TaskRunInclude | undefined>({
    id,
    status,
    expiredAt,
    completedAt,
    include,
    attemptStatus,
    error,
  }: T extends Prisma.TaskRunInclude ? InputWithInclude<T> : InputWithoutInclude): Promise<
    Output<T>
  > {
    logger.debug("Finalizing run marqs ack", {
      id,
      status,
      expiredAt,
      completedAt,
    });
    await marqs?.acknowledgeMessage(id);

    logger.debug("Finalizing run updating run status", {
      id,
      status,
      expiredAt,
      completedAt,
    });

    const run = await this._prisma.taskRun.update({
      where: { id },
      data: { status, expiredAt, completedAt },
      ...(include ? { include } : {}),
    });

    if (attemptStatus || error) {
      const latestAttempt = await this._prisma.taskRunAttempt.findFirst({
        where: { taskRunId: id },
        orderBy: { id: "desc" },
        take: 1,
      });

      if (latestAttempt) {
        logger.debug("Finalizing run attempt", {
          id: latestAttempt.id,
          status: attemptStatus,
          error,
        });

        await this._prisma.taskRunAttempt.update({
          where: { id: latestAttempt.id },
          data: { status: attemptStatus, error: error ? sanitizeError(error) : undefined },
        });
      } else {
        logger.debug("Finalizing run no attempt found", {
          id,
          status,
          expiredAt,
          completedAt,
          attemptStatus,
        });

        //todo maybe we should create a final attempt here?
      }
    }

    //resume any dependencies
    const resumeService = new ResumeDependentParentsService();
    const result = await resumeService.call({ id: run.id });

    if (result.success) {
      logger.log("FinalizeTaskRunService: Resumed dependent parents", { result });
    } else {
      logger.error("FinalizeTaskRunService: Failed to resume dependent parents", { result });
    }

    //enqueue alert
    if (isFailedRunStatus(run.status)) {
      await PerformTaskRunAlertsService.enqueue(run.id, this._prisma);
    }

    return run as Output<T>;
  }
}
