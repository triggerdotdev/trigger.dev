import { PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { marqs } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";

export class ResumeBatchRunService extends BaseService {
  public async call(batchRunId: string) {
    const batchRun = await this._prisma.batchTaskRun.findFirst({
      where: {
        id: batchRunId,
        dependentTaskAttemptId: {
          not: null,
        },
        status: "PENDING",
        items: {
          every: {
            taskRunAttemptId: {
              not: null,
            },
          },
        },
      },
      include: {
        dependentTaskAttempt: {
          include: {
            runtimeEnvironment: {
              include: {
                project: true,
                organization: true,
              },
            },
            taskRun: true,
          },
        },
        items: true,
      },
    });

    if (!batchRun || !batchRun.dependentTaskAttempt) {
      return;
    }

    // This batch has a dependent attempt and just finalized, we should resume that attempt
    const environment = batchRun.dependentTaskAttempt.runtimeEnvironment;

    // If we are in development, we don't need to resume the dependent task (that will happen automatically)
    if (environment.type === "DEVELOPMENT") {
      // We need to update the batchRun status so we don't resume it again
      await this._prisma.batchTaskRun.update({
        where: {
          id: batchRun.id,
        },
        data: {
          status: "COMPLETED",
        },
      });
      return;
    }

    const dependentRun = batchRun.dependentTaskAttempt.taskRun;

    if (batchRun.dependentTaskAttempt.status === "PAUSED" && batchRun.checkpointEventId) {
      // We need to update the batchRun status so we don't resume it again
      await this._prisma.batchTaskRun.update({
        where: {
          id: batchRun.id,
        },
        data: {
          status: "COMPLETED",
        },
      });

      await marqs?.enqueueMessage(
        environment,
        dependentRun.queue,
        dependentRun.id,
        {
          type: "RESUME",
          completedAttemptIds: [],
          resumableAttemptId: batchRun.dependentTaskAttempt.id,
          checkpointEventId: batchRun.checkpointEventId,
          projectId: batchRun.dependentTaskAttempt.runtimeEnvironment.projectId,
          environmentId: batchRun.dependentTaskAttempt.runtimeEnvironment.id,
          environmentType: batchRun.dependentTaskAttempt.runtimeEnvironment.type,
        },
        dependentRun.concurrencyKey ?? undefined
      );
    } else {
      if (batchRun.dependentTaskAttempt.status === "PAUSED" && !batchRun.checkpointEventId) {
        // In case of race conditions and other bugs, the status can be PAUSED without a checkpoint event
        // The worker may still be up, so we will try to resume the dependent attempt by sending a message to the worker (on dequeue)
        logger.error("Batch run resume: Attempt is paused but there's no checkpoint event", {
          batchRunId: batchRun.id,
          dependentTaskAttemptId: batchRun.dependentTaskAttempt.id,
        });
      }
    }
  }

  static async enqueue(batchRunId: string, tx: PrismaClientOrTransaction, runAt?: Date) {
    return await workerQueue.enqueue(
      "v3.resumeBatchRun",
      {
        batchRunId,
      },
      {
        tx,
        runAt,
        jobKey: `resumeBatchRun-${batchRunId}`,
      }
    );
  }
}
