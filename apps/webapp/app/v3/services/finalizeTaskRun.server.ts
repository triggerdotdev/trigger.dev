import { type Prisma, type TaskRun } from "@trigger.dev/database";
import { type FINISHED_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";

type BaseInput = {
  id: string;
  status?: FINISHED_STATUSES;
  expiredAt?: Date;
  completedAt?: Date;
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

    return run as Output<T>;
  }
}
