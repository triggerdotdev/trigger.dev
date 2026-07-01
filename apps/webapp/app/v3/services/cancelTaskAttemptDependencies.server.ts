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
          select: {
            taskRunId: true,
          },
        },
        batchDependencies: {
          include: {
            runDependencies: {
              select: {
                taskRunId: true,
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

    // Hydrate the dependent runs from both relation paths in a single batched read,
    // deduping the ids that feed the query while preserving the original iteration order.
    const taskRunIds = new Set<string>();
    for (const dependency of taskAttempt.dependencies) {
      taskRunIds.add(dependency.taskRunId);
    }
    for (const batchDependency of taskAttempt.batchDependencies) {
      for (const runDependency of batchDependency.runDependencies) {
        taskRunIds.add(runDependency.taskRunId);
      }
    }

    const runs =
      taskRunIds.size > 0
        ? await this.runStore.findRuns(
            {
              where: { id: { in: [...taskRunIds] } },
              select: {
                id: true,
                engine: true,
                status: true,
                friendlyId: true,
                taskEventStore: true,
                createdAt: true,
                completedAt: true,
              },
            },
            this._prisma
          )
        : [];

    const runMap = new Map(runs.map((run) => [run.id, run]));

    // TaskAttempt will either have dependencies or batchDependencies
    for (const dependency of taskAttempt.dependencies) {
      const run = runMap.get(dependency.taskRunId);
      if (run) {
        await cancelRunService.call(run);
      }
    }

    for (const batchDependency of taskAttempt.batchDependencies) {
      for (const runDependency of batchDependency.runDependencies) {
        const run = runMap.get(runDependency.taskRunId);
        if (run) {
          await cancelRunService.call(run);
        }
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
