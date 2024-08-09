import { PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { marqs } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";

export class ResumeBatchRunService extends BaseService {
  public async call(batchRunId: string, sourceTaskAttemptId: string) {
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

    // We need to update the batchRun status so we don't resume it again
    await this._prisma.batchTaskRun.update({
      where: {
        id: batchRun.id,
      },
      data: {
        status: "COMPLETED",
      },
    });

    // This batch has a dependent attempt and just finalized, we should resume that attempt
    const environment = batchRun.dependentTaskAttempt.runtimeEnvironment;

    // If we are in development, we don't need to resume the dependent task (that will happen automatically)
    if (environment.type === "DEVELOPMENT") {
      return;
    }

    const dependentRun = batchRun.dependentTaskAttempt.taskRun;

    if (batchRun.dependentTaskAttempt.status === "PAUSED") {
      if (!batchRun.checkpointEventId) {
        logger.error("Can't resume paused attempt without checkpoint event", {
          batchRunId: batchRun.id,
        });

        await marqs?.acknowledgeMessage(dependentRun.id);
        return;
      }

      await marqs?.enqueueMessage(
        environment,
        dependentRun.queue,
        dependentRun.id,
        {
          type: "RESUME",
          completedAttemptIds: [sourceTaskAttemptId],
          resumableAttemptId: batchRun.dependentTaskAttempt.id,
          checkpointEventId: batchRun.checkpointEventId,
          projectId: batchRun.dependentTaskAttempt.runtimeEnvironment.projectId,
          environmentId: batchRun.dependentTaskAttempt.runtimeEnvironment.id,
          environmentType: batchRun.dependentTaskAttempt.runtimeEnvironment.type,
        },
        dependentRun.concurrencyKey ?? undefined
      );
    } else {
      await marqs?.replaceMessage(dependentRun.id, {
        type: "RESUME",
        completedAttemptIds: batchRun.items.map((item) => item.taskRunAttemptId).filter(Boolean),
        resumableAttemptId: batchRun.dependentTaskAttempt.id,
      });
    }
  }

  static async enqueue(
    batchRunId: string,
    sourceTaskAttemptId: string,
    tx: PrismaClientOrTransaction,
    runAt?: Date
  ) {
    return await workerQueue.enqueue(
      "v3.resumeBatchRun",
      {
        batchRunId,
        sourceTaskAttemptId,
      },
      {
        tx,
        runAt,
        jobKey: `resumeBatchRun-${batchRunId}`,
      }
    );
  }
}
