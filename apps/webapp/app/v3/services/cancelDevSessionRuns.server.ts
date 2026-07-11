import { type RunStore } from "@internal/run-store";
import { z } from "zod";
import { type PrismaClientOrTransaction } from "~/db.server";
import { findLatestSession } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { commonWorker } from "../commonWorker.server";
import { type ReadThroughDeps, readThroughRun } from "../runOpsMigration/readThrough.server";
import { BaseService } from "./baseService.server";
import { type CancelableTaskRun, CancelTaskRunService } from "./cancelTaskRun.server";

export const CancelDevSessionRunsServiceOptions = z.object({
  runIds: z.array(z.string()),
  cancelledAt: z.coerce.date(),
  reason: z.string(),
  cancelledSessionId: z.string().optional(),
});

export type CancelDevSessionRunsServiceOptions = z.infer<typeof CancelDevSessionRunsServiceOptions>;

export class CancelDevSessionRunsService extends BaseService {
  // Injectable read-through deps for the run-ops TaskRun read. Undefined in production:
  // readThroughRun then uses its ~/db.server singleton handles and the boot split flag,
  // so single-DB is unchanged. Tests inject the hetero new/legacy handles + splitEnabled.
  readonly #readThroughDeps?: ReadThroughDeps;

  constructor(
    opts: {
      prisma?: PrismaClientOrTransaction;
      replica?: PrismaClientOrTransaction;
      runStore?: RunStore;
      readThroughDeps?: ReadThroughDeps;
    } = {}
  ) {
    super(opts.prisma, opts.replica, opts.runStore);
    this.#readThroughDeps = opts.readThroughDeps;
  }

  public async call(options: CancelDevSessionRunsServiceOptions) {
    const cancelledSession = options.cancelledSessionId
      ? await this._prisma.runtimeEnvironmentSession.findFirst({
          where: { id: options.cancelledSessionId },
        })
      : undefined;

    if (cancelledSession) {
      const latestSession = await findLatestSession(cancelledSession.environmentId, this._replica);

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

    // readThroughRun resolves residency from the run id alone; an env scope is only
    // available when a cancelled session was resolved.
    const environmentId = cancelledSession?.environmentId ?? "";

    for (const runId of options.runIds) {
      await this.#cancelInProgressRun(
        runId,
        cancelTaskRunService,
        options.cancelledAt,
        options.reason,
        environmentId
      );
    }
  }

  async #cancelInProgressRun(
    runId: string,
    service: CancelTaskRunService,
    cancelledAt: Date,
    reason: string,
    environmentId: string
  ) {
    logger.debug("Cancelling in progress run", { runId });

    // Read-through: new store first, legacy read replica for an old
    // in-retention run; single plain read in single-DB passthrough.
    const where = runId.startsWith("run_") ? { friendlyId: runId } : { id: runId };

    const result = await readThroughRun<CancelableTaskRun>({
      runId,
      environmentId,
      readNew: (client) =>
        client.taskRun.findFirst({
          where,
          select: {
            id: true,
            engine: true,
            status: true,
            friendlyId: true,
            taskEventStore: true,
            createdAt: true,
            completedAt: true,
          },
        }),
      readLegacy: (replica) =>
        replica.taskRun.findFirst({
          where,
          select: {
            id: true,
            engine: true,
            status: true,
            friendlyId: true,
            taskEventStore: true,
            createdAt: true,
            completedAt: true,
          },
        }),
      deps: this.#readThroughDeps,
    });

    if (result.source === "not-found" || result.source === "past-retention") {
      return;
    }

    const taskRun = result.value;

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
