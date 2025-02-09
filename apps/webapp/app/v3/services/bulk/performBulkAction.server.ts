import assertNever from "assert-never";
import { PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { BaseService } from "../baseService.server";
import { CancelTaskRunService } from "../cancelTaskRun.server";
import { ReplayTaskRunService } from "../replayTaskRun.server";

export class PerformBulkActionService extends BaseService {
  public async performBulkActionItem(bulkActionItemId: string) {
    const item = await this._prisma.bulkActionItem.findFirst({
      where: { id: bulkActionItemId },
      include: {
        group: true,
        sourceRun: true,
        destinationRun: true,
      },
    });

    if (!item) {
      return;
    }

    if (item.status !== "PENDING") {
      return;
    }

    switch (item.group.type) {
      case "REPLAY": {
        const service = new ReplayTaskRunService(this._prisma);
        const result = await service.call(item.sourceRun);

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

        const result = await service.call(item.sourceRun);

        await this._prisma.bulkActionItem.update({
          where: { id: item.id },
          data: {
            destinationRunId: item.sourceRun.id,
            status: result ? "COMPLETED" : "FAILED",
            error: result ? undefined : "Task wasn't cancelable",
          },
        });

        break;
      }
      default: {
        assertNever(item.group.type);
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
      include: {
        items: true,
      },
      where: { id: bulkActionGroupId },
    });

    if (!actionGroup) {
      return;
    }

    for (const item of actionGroup.items) {
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
