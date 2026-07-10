import assertNever from "assert-never";
import type { PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { BaseService } from "../baseService.server";
import { CancelTaskRunService } from "../cancelTaskRun.server";
import { ReplayTaskRunService } from "../replayTaskRun.server";

export class PerformBulkActionService extends BaseService {
  public async performBulkActionItem(bulkActionItemId: string) {
    const item = await this._prisma.bulkActionItem.findFirst({
      where: { id: bulkActionItemId },
      select: {
        id: true,
        groupId: true,
        type: true,
        status: true,
        sourceRunId: true,
      },
    });

    if (!item) {
      return;
    }

    if (item.status !== "PENDING") {
      return;
    }

    // Fetch the source run through the store (it may reside in a different DB than the item).
    const sourceRun = await this.runStore.findRunOrThrow({ id: item.sourceRunId }, this._prisma);

    switch (item.type) {
      case "REPLAY": {
        const service = new ReplayTaskRunService(this._prisma);
        const result = await service.call(sourceRun, { triggerSource: "dashboard" });

        await this._prisma.bulkActionItem.update({
          where: { id: item.id },
          data: {
            destinationRunId: result?.id,
            status: result ? "COMPLETED" : "FAILED",
            error: result ? undefined : "Failed to replay task run",
          },
        });

        break;
      }
      case "CANCEL": {
        const service = new CancelTaskRunService(this._prisma);

        const result = await service.call(sourceRun);

        await this._prisma.bulkActionItem.update({
          where: { id: item.id },
          data: {
            destinationRunId: sourceRun.id,
            status: result ? "COMPLETED" : "FAILED",
            error: result ? undefined : "Task wasn't cancelable",
          },
        });

        break;
      }
      default: {
        assertNever(item.type);
      }
    }

    const groupItems = await this._prisma.bulkActionItem.findMany({
      where: { groupId: item.groupId },
      select: {
        status: true,
      },
    });

    const isGroupCompleted = groupItems.every((item) => item.status !== "PENDING");

    if (isGroupCompleted) {
      await this._prisma.bulkActionItem.update({
        where: { id: item.id },
        data: {
          status: "COMPLETED",
        },
      });
    }
  }

  public async enqueueBulkActionItem(bulkActionItemId: string, groupId: string) {
    await workerQueue.enqueue(
      "v3.performBulkActionItem",
      {
        bulkActionItemId,
      },
      {
        jobKey: `performBulkActionItem:${bulkActionItemId}`,
      }
    );
  }

  public async call(bulkActionGroupId: string) {
    const actionGroup = await this._prisma.bulkActionGroup.findFirst({
      where: { id: bulkActionGroupId },
      select: { id: true },
    });

    if (!actionGroup) {
      return;
    }

    const items = await this._prisma.bulkActionItem.findMany({
      where: { groupId: bulkActionGroupId },
      select: { id: true },
    });

    for (const item of items) {
      await this.enqueueBulkActionItem(item.id, bulkActionGroupId);
    }
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
