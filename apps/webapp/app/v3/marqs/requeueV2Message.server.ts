import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";

import { BaseService } from "../services/baseService.server";
import { type PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { marqsv2 } from "./v2.server";

export class RequeueV2Message extends BaseService {
  public async call(runId: string) {
    logger.debug("[RequeueV2Message] Requeueing task run", { runId });

    marqsv2?.nackMessage(runId);
  }

  public static async enqueue(runId: string, runAt?: Date, tx?: PrismaClientOrTransaction) {
    return await workerQueue.enqueue(
      "v2.requeueMessage",
      { runId },
      { runAt, jobKey: `requeueV2Message:${runId}` }
    );
  }

  public static async dequeue(runId: string, tx?: PrismaClientOrTransaction) {
    return await workerQueue.dequeue(`requeueV2Message:${runId}`, { tx });
  }
}
