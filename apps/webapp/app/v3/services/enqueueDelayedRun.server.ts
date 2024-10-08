import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";
import { parseNaturalLanguageDuration } from "./triggerTask.server";
import { workerQueue } from "~/services/worker.server";
import { $transaction } from "~/db.server";

export class EnqueueDelayedRunService extends BaseService {
  public async call(runId: string) {
    const run = await this._prisma.taskRun.findUnique({
      where: {
        id: runId,
      },
      include: {
        runtimeEnvironment: {
          include: {
            organization: true,
            project: true,
          },
        },
      },
    });

    if (!run) {
      logger.debug("Could not find delayed run to enqueue", {
        runId,
      });

      return;
    }

    if (run.status !== "DELAYED") {
      logger.debug("Delayed run cannot be enqueued because it's not in DELAYED status", {
        run,
      });

      return;
    }

    await $transaction(this._prisma, async (tx) => {
      await tx.taskRun.update({
        where: {
          id: run.id,
        },
        data: {
          status: "PENDING",
          queuedAt: new Date(),
        },
      });

      if (run.ttl) {
        const expireAt = parseNaturalLanguageDuration(run.ttl);

        if (expireAt) {
          await workerQueue.enqueue(
            "v3.expireRun",
            { runId: run.id },
            { tx, runAt: expireAt, jobKey: `v3.expireRun.${run.id}` }
          );
        }
      }
    });

    await marqs?.enqueueMessage(
      run.runtimeEnvironment,
      run.queue,
      run.id,
      {
        type: "EXECUTE",
        taskIdentifier: run.taskIdentifier,
        projectId: run.runtimeEnvironment.projectId,
        environmentId: run.runtimeEnvironment.id,
        environmentType: run.runtimeEnvironment.type,
      },
      run.concurrencyKey ?? undefined
    );
  }
}
