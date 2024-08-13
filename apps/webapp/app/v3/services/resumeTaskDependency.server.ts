import { PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { marqs } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";

export class ResumeTaskDependencyService extends BaseService {
  public async call(dependencyId: string, sourceTaskAttemptId: string) {
    const dependency = await this._prisma.taskRunDependency.findUnique({
      where: { id: dependencyId },
      include: {
        taskRun: {
          include: {
            runtimeEnvironment: {
              include: {
                project: true,
                organization: true,
              },
            },
          },
        },
        dependentAttempt: {
          include: {
            taskRun: true,
          },
        },
      },
    });

    // Dependencies with a dependentBatchRun are handled already by the ResumeBatchRunService
    if (!dependency || !dependency.dependentAttempt) {
      return;
    }

    if (dependency.taskRun.runtimeEnvironment.type === "DEVELOPMENT") {
      return;
    }

    const dependentRun = dependency.dependentAttempt.taskRun;

    if (dependency.dependentAttempt.status === "PAUSED") {
      if (!dependency.checkpointEventId) {
        logger.error("Can't resume paused attempt without checkpoint event", {
          attemptId: dependency.id,
        });

        await marqs?.acknowledgeMessage(dependentRun.id);
        return;
      }

      await marqs?.enqueueMessage(
        dependency.taskRun.runtimeEnvironment,
        dependentRun.queue,
        dependentRun.id,
        {
          type: "RESUME",
          completedAttemptIds: [sourceTaskAttemptId],
          resumableAttemptId: dependency.dependentAttempt.id,
          checkpointEventId: dependency.checkpointEventId,
          projectId: dependency.taskRun.runtimeEnvironment.projectId,
          environmentId: dependency.taskRun.runtimeEnvironment.id,
          environmentType: dependency.taskRun.runtimeEnvironment.type,
        },
        dependentRun.concurrencyKey ?? undefined
      );
    } else {
      await marqs?.replaceMessage(dependentRun.id, {
        type: "RESUME",
        completedAttemptIds: [sourceTaskAttemptId],
        resumableAttemptId: dependency.dependentAttempt.id,
      });
    }
  }

  static async enqueue(
    dependencyId: string,
    sourceTaskAttemptId: string,
    tx: PrismaClientOrTransaction,
    runAt?: Date
  ) {
    return await workerQueue.enqueue(
      "v3.resumeTaskDependency",
      {
        dependencyId,
        sourceTaskAttemptId,
      },
      {
        tx,
        runAt,
      }
    );
  }
}
