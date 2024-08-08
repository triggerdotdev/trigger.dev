import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";
import { eventRepository } from "../eventRepository.server";

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

    /*
    "EXPIRED"

    Steps:
    1. Updates the run to expired, with dates
    2. Completes the run span OTEL event
    3. marqs ack

    Inputs:
    - taskRun: id, spanId, ttl

    Questions:
    - Why do we ack after the db update?
    */

    await this._prisma.taskRun.update({
      where: {
        id: run.id,
      },
      data: {
        status: "EXPIRED",
        expiredAt: new Date(),
        completedAt: new Date(),
      },
    });

    await eventRepository.completeEvent(run.spanId, {
      endTime: new Date(),
      attributes: {
        isError: true,
      },
      events: [
        {
          name: "exception",
          time: new Date(),
          properties: {
            exception: {
              message: `Run expired because the TTL (${run.ttl}) was reached`,
            },
          },
        },
      ],
    });

    await marqs?.acknowledgeMessage(run.id);
  }
}
