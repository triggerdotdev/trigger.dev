import { PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { MarQS, marqs, MarQSPriorityLevel } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";

export class ResumeTaskDependencyService extends BaseService {
  public async call(dependencyId: string, sourceTaskAttemptId: string) {
    const dependency = await this._prisma.taskRunDependency.findFirst({
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

    if (dependency.dependentAttempt.status === "PAUSED" && dependency.checkpointEventId) {
      logger.debug(
        "Task dependency resume: Attempt is paused and there's a checkpoint. Enqueuing resume with checkpoint.",
        {
          attemptId: dependency.id,
          dependentAttempt: dependency.dependentAttempt,
          checkpointEventId: dependency.checkpointEventId,
          hasCheckpointEvent: !!dependency.checkpointEventId,
          runId: dependentRun.id,
        }
      );

      // TODO: use the new priority queue thingie
      await marqs?.enqueueMessage(
        dependency.taskRun.runtimeEnvironment,
        dependentRun.queue,
        dependentRun.id,
        {
          type: "RESUME",
          completedAttemptIds: [sourceTaskAttemptId],
          resumableAttemptId: dependency.dependentAttempt.id,
          checkpointEventId: dependency.checkpointEventId,
          taskIdentifier: dependency.taskRun.taskIdentifier,
          projectId: dependency.taskRun.runtimeEnvironment.projectId,
          environmentId: dependency.taskRun.runtimeEnvironment.id,
          environmentType: dependency.taskRun.runtimeEnvironment.type,
        },
        dependentRun.concurrencyKey ?? undefined,
        dependentRun.queueTimestamp ?? dependentRun.createdAt,
        undefined,
        MarQSPriorityLevel.resume
      );
    } else {
      logger.debug("Task dependency resume: Attempt is not paused or there's no checkpoint event", {
        attemptId: dependency.id,
        dependentAttempt: dependency.dependentAttempt,
        checkpointEventId: dependency.checkpointEventId,
        hasCheckpointEvent: !!dependency.checkpointEventId,
        runId: dependentRun.id,
      });

      if (dependency.dependentAttempt.status === "PAUSED" && !dependency.checkpointEventId) {
        // In case of race conditions the status can be PAUSED without a checkpoint event
        // When the checkpoint is created, it will continue the run
        logger.error("Task dependency resume: Attempt is paused but there's no checkpoint event", {
          attemptId: dependency.id,
          dependentAttemptId: dependency.dependentAttempt.id,
        });
        return;
      }

      await marqs?.requeueMessage(
        dependentRun.id,
        {
          type: "RESUME",
          completedAttemptIds: [sourceTaskAttemptId],
          resumableAttemptId: dependency.dependentAttempt.id,
          checkpointEventId: dependency.checkpointEventId ?? undefined,
          taskIdentifier: dependency.taskRun.taskIdentifier,
          projectId: dependency.taskRun.runtimeEnvironment.projectId,
          environmentId: dependency.taskRun.runtimeEnvironment.id,
          environmentType: dependency.taskRun.runtimeEnvironment.type,
        },
        (dependentRun.queueTimestamp ?? dependentRun.createdAt).getTime(),
        MarQSPriorityLevel.resume
      );
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
