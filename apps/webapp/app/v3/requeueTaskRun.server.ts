import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";

import assertNever from "assert-never";
import { FailedTaskRunService } from "./failedTaskRun.server";
import { BaseService } from "./services/baseService.server";
import { PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";

export class RequeueTaskRunService extends BaseService {
  public async call(runId: string) {}

  public static async enqueue(runId: string, runAt?: Date, tx?: PrismaClientOrTransaction) {}

  public static async dequeue(runId: string, tx?: PrismaClientOrTransaction) {}
}
