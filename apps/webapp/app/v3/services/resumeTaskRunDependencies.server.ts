import { type BatchTaskRunItem, type TaskRunAttempt, type TaskRunDependency } from "@trigger.dev/database";
import { $transaction, type PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { BaseService } from "./baseService.server";
import { ResumeBatchRunService } from "./resumeBatchRun.server";
import { ResumeTaskDependencyService } from "./resumeTaskDependency.server";

export class ResumeTaskRunDependenciesService extends BaseService {
  public async call(attemptId: string) {
    const taskAttempt = await this._prisma.taskRunAttempt.findUnique({
      where: { id: attemptId },
      include: {
        taskRun: {
          include: {
            batchItems: true,
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
        await this.#resumeBatchItem(batchItem, taskAttempt);
      }
      return;
    }

    if (dependency) {
      await this.#resumeDependency(dependency, taskAttempt);
      return;
    }
  }

  async #resumeBatchItem(batchItem: BatchTaskRunItem, taskAttempt: TaskRunAttempt) {
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

      await ResumeBatchRunService.enqueue(batchItem.batchTaskRunId, taskAttempt.id, tx);
    });
  }

  async #resumeDependency(dependency: TaskRunDependency, taskAttempt: TaskRunAttempt) {
    await ResumeTaskDependencyService.enqueue(dependency.id, taskAttempt.id, this._prisma);
  }

  static async enqueue(attemptId: string, tx: PrismaClientOrTransaction, runAt?: Date) {
    return await workerQueue.enqueue(
      "v3.resumeTaskRunDependencies",
      {
        attemptId,
      },
      {
        tx,
        runAt,
        jobKey: `resumeTaskRunDependencies:${attemptId}`,
      }
    );
  }
}
