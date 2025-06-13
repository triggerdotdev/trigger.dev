import {
  BatchTaskRun,
  BatchTaskRunItem,
  TaskRunAttempt,
  TaskRunDependency,
} from "@trigger.dev/database";
import { $transaction, PrismaClientOrTransaction } from "~/db.server";
import { commonWorker } from "../commonWorker.server";
import { BaseService } from "./baseService.server";
import { ResumeBatchRunService } from "./resumeBatchRun.server";
import { ResumeTaskDependencyService } from "./resumeTaskDependency.server";
import { completeBatchTaskRunItemV3 } from "./batchTriggerV3.server";

export class ResumeTaskRunDependenciesService extends BaseService {
  public async call(attemptId: string) {
    const taskAttempt = await this._prisma.taskRunAttempt.findFirst({
      where: { id: attemptId },
      include: {
        taskRun: {
          include: {
            batchItems: {
              include: {
                batchTaskRun: true,
              },
            },
            dependency: {
              include: {
                dependentAttempt: true,
                dependentBatchRun: true,
              },
            },
          },
        },
        backgroundWorkerTask: true,
        runtimeEnvironment: true,
      },
    });

    if (!taskAttempt) {
      return;
    }

    if (taskAttempt.runtimeEnvironment.type === "DEVELOPMENT") {
      return;
    }

    const { batchItems, dependency } = taskAttempt.taskRun;

    if (!batchItems.length && !dependency) {
      return;
    }

    if (batchItems.length) {
      for (const batchItem of batchItems) {
        await this.#resumeBatchItem(batchItem, batchItem.batchTaskRun, taskAttempt);
      }
      return;
    }

    if (dependency) {
      await this.#resumeDependency(dependency, taskAttempt);
      return;
    }
  }

  async #resumeBatchItem(
    batchItem: BatchTaskRunItem,
    batchTaskRun: BatchTaskRun,
    taskAttempt: TaskRunAttempt
  ) {
    if (batchTaskRun.batchVersion === "v3") {
      await completeBatchTaskRunItemV3(
        batchItem.id,
        batchTaskRun.id,
        this._prisma,
        true,
        taskAttempt.id
      );
    } else {
      await $transaction(this._prisma, async (tx) => {
        await tx.batchTaskRunItem.update({
          where: {
            id: batchItem.id,
          },
          data: {
            status: "COMPLETED",
            taskRunAttemptId: taskAttempt.id,
          },
        });

        await ResumeBatchRunService.enqueue(batchItem.batchTaskRunId, false, tx);
      });
    }
  }

  async #resumeDependency(dependency: TaskRunDependency, taskAttempt: TaskRunAttempt) {
    await ResumeTaskDependencyService.enqueue(dependency.id, taskAttempt.id, this._prisma);
  }

  static async enqueue(attemptId: string, tx: PrismaClientOrTransaction, runAt?: Date) {
    return await commonWorker.enqueue({
      id: `resumeTaskRunDependencies:${attemptId}`,
      job: "v3.resumeTaskRunDependencies",
      payload: {
        attemptId,
      },
      availableAt: runAt,
    });
  }
}
