import { PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { BaseService } from "../baseService.server";

export class PerformBulkActionService extends BaseService {
  public async call(bulkActionGroupId: string) {
    const actionGroup = await this._prisma.bulkActionGroup.findUnique({
      include: {
        items: true,
      },
      where: { id: bulkActionGroupId },
    });

    if (!actionGroup) {
      return;
    }

    //todo perform for each item, update status
    //todo update overall status
  }

  static async enqueue(bulkActionGroupId: string, tx: PrismaClientOrTransaction, runAt?: Date) {
    return await workerQueue.enqueue(
      "v3.performBulkAction",
      {
        bulkActionGroupId,
      },
      {
        tx,
        runAt,
        jobKey: `performBulkAction:${bulkActionGroupId}`,
      }
    );
  }
}
