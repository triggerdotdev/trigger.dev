import { PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";
import { CancelTaskRunService } from "./cancelTaskRun.server";

export class CancelTaskAttemptDependenciesService extends BaseService {
  public async call(attemptId: string) {
    const taskAttempt = await this._prisma.taskRunAttempt.findUnique({
      where: { id: attemptId },
      include: {
        dependencies: {
          include: {
            taskRun: true,
          },
        },
      },
    });

    if (!taskAttempt) {
      return;
    }

    if (!taskAttempt.dependencies.length) {
      return;
    }

    if (taskAttempt.status !== "CANCELED") {
      logger.debug("Task attempt is not cancelled, continuing anyway", {
        attemptId,
        status: taskAttempt.status,
      });
    }

    const cancelRunService = new CancelTaskRunService();

    for (const dependency of taskAttempt.dependencies) {
      await cancelRunService.call(dependency.taskRun);
    }
  }

  static async enqueue(attemptId: string, tx: PrismaClientOrTransaction, runAt?: Date) {
    return await workerQueue.enqueue(
      "v3.cancelTaskAttemptDependencies",
      {
        attemptId,
      },
      {
        tx,
        runAt,
        jobKey: `cancelTaskAttemptDependencies:${attemptId}`,
      }
    );
  }
}
