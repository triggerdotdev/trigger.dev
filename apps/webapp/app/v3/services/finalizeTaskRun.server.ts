import { TaskRun, type Prisma, type TaskRunStatus } from "@trigger.dev/database";
import { type PrismaClientOrTransaction } from "~/db.server";
import { marqs } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";

type BaseInput = {
  tx: PrismaClientOrTransaction;
  id: string;
  status?: TaskRunStatus;
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
    tx,
    id,
    status,
    expiredAt,
    completedAt,
    include,
  }: T extends Prisma.TaskRunInclude ? InputWithInclude<T> : InputWithoutInclude): Promise<
    Output<T>
  > {
    await marqs?.acknowledgeMessage(id);

    const run = await tx.taskRun.update({
      where: { id },
      data: { status, expiredAt, completedAt },
      ...(include ? { include } : {}),
    });

    return run as Output<T>;
  }
}
