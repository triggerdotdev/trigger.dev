import { marqs } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";
import { type TaskRunStatus } from "@trigger.dev/database";
import { type PrismaClientOrTransaction } from "~/db.server";

type Input = {
  tx: PrismaClientOrTransaction;
  id: string;
  status: TaskRunStatus;
  expiredAt?: Date;
  completedAt?: Date;
};

//todo
//1. ack
//2. Using the passed in transaction client, update the run status and any optional dates passed in
//3. Remove the run from it's concurrency sets in Redis
//4? Do alerts if the run has failed

export class FinalizeTaskRunService extends BaseService {
  public async call({ tx, id, status, expiredAt, completedAt }: Input) {
    await marqs?.acknowledgeMessage(id);

    const run = await tx.taskRun.update({
      where: {
        id,
      },
      data: {
        status,
        expiredAt,
        completedAt,
      },
    });

    return run;
  }
}
