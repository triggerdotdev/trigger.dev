import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";

export class ExpireEnqueuedRunService extends BaseService {
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
      logger.debug("Could not find enqueued run to expire", {
        runId,
      });

      return;
    }

    if (run.status !== "PENDING") {
      logger.debug("Run cannot be expired because it's not in PENDING status", {
        run,
      });

      return;
    }

    logger.debug("Expiring enqueued run", {
      run,
    });

    await this._prisma.taskRun.update({
      where: {
        id: run.id,
      },
      data: {
        status: "EXPIRED",
        expiredAt: new Date(),
      },
    });

    await marqs?.acknowledgeMessage(run.id);
  }
}
