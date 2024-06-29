import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";

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

    await this._prisma.taskRun.update({
      where: {
        id: run.id,
      },
      data: {
        status: "PENDING",
        queuedAt: new Date(),
      },
    });

    await marqs?.enqueueMessage(
      run.runtimeEnvironment,
      run.queue,
      run.id,
      { type: "EXECUTE", taskIdentifier: run.taskIdentifier },
      run.concurrencyKey ?? undefined
    );
  }
}
