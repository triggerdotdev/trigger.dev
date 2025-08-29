import { PrismaClientOrTransaction } from "~/db.server";
import { commonWorker } from "../commonWorker.server";
import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";
import { CancelTaskRunService } from "./cancelTaskRun.server";

export class CancelTaskAttemptDependenciesService extends BaseService {
  public async call(attemptId: string) {
    const taskAttempt = await this._prisma.taskRunAttempt.findFirst({
      where: { id: attemptId },
      include: {
        dependencies: {
          include: {
            taskRun: true,
          },
        },
        batchDependencies: {
          include: {
            runDependencies: {
              include: {
                taskRun: true,
              },
            },
          },
        },
      },
    });

    if (!taskAttempt) {
      return;
    }

    if (taskAttempt.status !== "CANCELED") {
      logger.debug("Task attempt is not cancelled, continuing anyway", {
        attemptId,
        status: taskAttempt.status,
      });
    }

    const cancelRunService = new CancelTaskRunService();

    logger.debug("Cancelling task attempt dependencies", {
      taskAttempt,
      dependencies: taskAttempt.dependencies,
      batchDependencies: taskAttempt.batchDependencies,
    });

    // TaskAttempt will either have dependencies or batchDependencies
    for (const dependency of taskAttempt.dependencies) {
      await cancelRunService.call(dependency.taskRun);
    }

    for (const batchDependency of taskAttempt.batchDependencies) {
      for (const runDependency of batchDependency.runDependencies) {
        await cancelRunService.call(runDependency.taskRun);
      }
    }
  }

  static async enqueue(attemptId: string, runAt?: Date) {
    return await commonWorker.enqueue({
      id: `cancelTaskAttemptDependencies:${attemptId}`,
      job: "v3.cancelTaskAttemptDependencies",
      payload: {
        attemptId,
      },
      availableAt: runAt,
    });
  }
}
