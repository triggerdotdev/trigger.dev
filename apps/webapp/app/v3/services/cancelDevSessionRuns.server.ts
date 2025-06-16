import { z } from "zod";
import { findLatestSession } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { commonWorker } from "../commonWorker.server";
import { BaseService } from "./baseService.server";
import { CancelTaskRunService } from "./cancelTaskRun.server";

export const CancelDevSessionRunsServiceOptions = z.object({
  runIds: z.array(z.string()),
  cancelledAt: z.coerce.date(),
  reason: z.string(),
  cancelledSessionId: z.string().optional(),
});

export type CancelDevSessionRunsServiceOptions = z.infer<typeof CancelDevSessionRunsServiceOptions>;

export class CancelDevSessionRunsService extends BaseService {
  public async call(options: CancelDevSessionRunsServiceOptions) {
    const cancelledSession = options.cancelledSessionId
      ? await this._prisma.runtimeEnvironmentSession.findFirst({
          where: { id: options.cancelledSessionId },
        })
      : undefined;

    if (cancelledSession) {
      const latestSession = await findLatestSession(cancelledSession.environmentId);

      if (
        latestSession &&
        latestSession.id !== cancelledSession.id &&
        !latestSession.disconnectedAt
      ) {
        logger.debug("Not cancelling runs because there is a newer session", {
          cancelledSessionId: cancelledSession.id,
          latestSessionId: latestSession.id,
        });

        return;
      }
    }

    logger.debug(
      "Cancelling in progress runs for dev session because there isn't a newer connected session",
      {
        options,
        cancelledSession,
      }
    );

    const cancelTaskRunService = new CancelTaskRunService();

    for (const runId of options.runIds) {
      await this.#cancelInProgressRun(
        runId,
        cancelTaskRunService,
        options.cancelledAt,
        options.reason
      );
    }
  }

  async #cancelInProgressRun(
    runId: string,
    service: CancelTaskRunService,
    cancelledAt: Date,
    reason: string
  ) {
    logger.debug("Cancelling in progress run", { runId });

    const taskRun = runId.startsWith("run_")
      ? await this._prisma.taskRun.findFirst({
          where: { friendlyId: runId },
        })
      : await this._prisma.taskRun.findFirst({
          where: { id: runId },
        });

    if (!taskRun) {
      return;
    }

    try {
      await service.call(taskRun, { reason, cancelAttempts: true, cancelledAt });
    } catch (e) {
      logger.error("Failed to cancel in progress run", {
        runId,
        error: e,
      });
    }
  }

  static async enqueue(options: CancelDevSessionRunsServiceOptions, runAt?: Date) {
    return await commonWorker.enqueue({
      id: options.cancelledSessionId
        ? `cancelDevSessionRuns:${options.cancelledSessionId}`
        : undefined,
      job: "v3.cancelDevSessionRuns",
      payload: options,
      availableAt: runAt,
    });
  }
}
