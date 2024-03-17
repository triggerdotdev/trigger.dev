import { BatchTaskRunItem, TaskRunAttempt, TaskRunDependency } from "@trigger.dev/database";
import { $transaction, PrismaClientOrTransaction } from "~/db.server";
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
            runtimeEnvironment: true,
            batchItem: true,
            dependency: {
              include: {
                dependentAttempt: true,
                dependentBatchRun: true,
              },
            },
          },
        },
        backgroundWorkerTask: true,
      },
    });

    if (!taskAttempt) {
      return;
    }

    if (taskAttempt.taskRun.runtimeEnvironment.type === "DEVELOPMENT") {
      return;
    }

    const { batchItem, dependency } = taskAttempt.taskRun;

    if (!batchItem && !dependency) {
      return;
    }

    if (batchItem) {
      await this.#resumeBatchItem(batchItem, taskAttempt);
      return;
    }

    if (dependency && dependency.dependentAttempt) {
      await this.#resumeDependency(dependency, taskAttempt);
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
