import { PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { BaseService } from "../baseService.server";
import assertNever from "assert-never";
import { BulkActionItem } from "@trigger.dev/database";
import { ReplayTaskRunService } from "../replayTaskRun.server";
import { CancelTaskRunService } from "../cancelTaskRun.server";

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

    switch (actionGroup.type) {
      case "REPLAY":
        await this.#replay(actionGroup.items);
        break;
      case "CANCEL":
        await this.#cancel(actionGroup.items);
        break;
      default: {
        assertNever(actionGroup.type);
      }
    }

    await this._prisma.bulkActionGroup.update({
      where: { id: actionGroup.id },
      data: {
        status: "COMPLETED",
      },
    });
  }

  async #replay(items: BulkActionItem[]) {
    const existingRuns = await this._prisma.taskRun.findMany({
      where: {
        id: {
          in: items.map((item) => item.sourceRunId),
        },
      },
    });

    const service = new ReplayTaskRunService(this._prisma);
    for (const run of existingRuns) {
      const result = await service.call(run);
      await this._prisma.bulkActionItem.update({
        where: { id: items.find((item) => item.sourceRunId === run.id)!.id },
        data: {
          destinationRunId: result?.id,
          status: result ? "COMPLETED" : "FAILED",
          error: result ? undefined : "Failed to replay task run",
        },
      });
    }
  }

  async #cancel(items: BulkActionItem[]) {
    const existingRuns = await this._prisma.taskRun.findMany({
      where: {
        id: {
          in: items.map((item) => item.sourceRunId),
        },
      },
    });

    const service = new CancelTaskRunService(this._prisma);
    for (const run of existingRuns) {
      const result = await service.call(run);
      await this._prisma.bulkActionItem.update({
        where: { id: items.find((item) => item.sourceRunId === run.id)!.id },
        data: {
          destinationRunId: result ? result.id : undefined,
          status: result ? "COMPLETED" : "FAILED",
          error: result ? undefined : "Task wasn't cancelable",
        },
      });
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
