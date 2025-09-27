import { type Prisma } from "@trigger.dev/database";
import assertNever from "assert-never";
import { logger } from "~/services/logger.server";
import { socketIo } from "../handleSocketIo.server";
import { devPubSub } from "../marqs/devPubSub.server";
import { CANCELLABLE_ATTEMPT_STATUSES, isCancellableRunStatus } from "../taskStatus";
import { BaseService } from "./baseService.server";
import { CancelAttemptService } from "./cancelAttempt.server";
import { CancelTaskAttemptDependenciesService } from "./cancelTaskAttemptDependencies.server";
import { CancelableTaskRun } from "./cancelTaskRun.server";
import { FinalizeTaskRunService } from "./finalizeTaskRun.server";
import { tryCatch } from "@trigger.dev/core/utils";
import { resolveEventRepositoryForStore } from "../eventRepository/index.server";

type ExtendedTaskRun = Prisma.TaskRunGetPayload<{
  include: {
    runtimeEnvironment: true;
    lockedToVersion: true;
  };
}>;

type ExtendedTaskRunAttempt = Prisma.TaskRunAttemptGetPayload<{
  include: {
    backgroundWorker: true;
  };
}>;

export type CancelTaskRunServiceOptions = {
  reason?: string;
  cancelAttempts?: boolean;
  cancelledAt?: Date;
  bulkActionId?: string;
};

export class CancelTaskRunServiceV1 extends BaseService {
  public async call(taskRun: CancelableTaskRun, options?: CancelTaskRunServiceOptions) {
    const opts = {
      reason: "Task run was cancelled by user",
      cancelAttempts: true,
      cancelledAt: new Date(),
      ...options,
    };

    // Make sure the task run is in a cancellable state
    if (!isCancellableRunStatus(taskRun.status)) {
      logger.info("Task run is not in a cancellable state", {
        runId: taskRun.id,
        status: taskRun.status,
      });

      //add the bulk action id to the run
      if (opts.bulkActionId) {
        await this._prisma.taskRun.update({
          where: { id: taskRun.id },
          data: {
            bulkActionGroupIds: {
              push: opts.bulkActionId,
            },
          },
        });
      }

      return;
    }

    const finalizeService = new FinalizeTaskRunService();
    const cancelledTaskRun = await finalizeService.call({
      id: taskRun.id,
      status: "CANCELED",
      completedAt: opts.cancelledAt,
      bulkActionId: opts.bulkActionId,
      include: {
        attempts: {
          where: {
            status: {
              in: CANCELLABLE_ATTEMPT_STATUSES,
            },
          },
          include: {
            backgroundWorker: true,
            dependencies: {
              include: {
                taskRun: true,
              },
            },
            batchTaskRunItems: {
              include: {
                taskRun: true,
              },
            },
          },
        },
        runtimeEnvironment: true,
        lockedToVersion: true,
        project: true,
      },
      attemptStatus: "CANCELED",
      error: {
        type: "STRING_ERROR",
        raw: opts.reason,
      },
    });

    const eventRepository = resolveEventRepositoryForStore(cancelledTaskRun.taskEventStore);

    const [cancelRunEventError] = await tryCatch(
      eventRepository.cancelRunEvent({
        reason: opts.reason,
        run: cancelledTaskRun,
        cancelledAt: opts.cancelledAt,
      })
    );

    if (cancelRunEventError) {
      logger.error("[CancelTaskRunServiceV1] Failed to cancel run event", {
        error: cancelRunEventError,
        runId: cancelledTaskRun.id,
      });
    }

    // Cancel any in progress attempts
    if (opts.cancelAttempts) {
      await this.#cancelPotentiallyRunningAttempts(cancelledTaskRun, cancelledTaskRun.attempts);
      await this.#cancelRemainingRunWorkers(cancelledTaskRun);
    }

    return {
      id: cancelledTaskRun.id,
    };
  }

  async #cancelPotentiallyRunningAttempts(
    run: ExtendedTaskRun,
    attempts: ExtendedTaskRunAttempt[]
  ) {
    for (const attempt of attempts) {
      await CancelTaskAttemptDependenciesService.enqueue(attempt.id);

      if (run.runtimeEnvironment.type === "DEVELOPMENT") {
        // Signal the task run attempt to stop
        await devPubSub.publish(
          `backgroundWorker:${attempt.backgroundWorkerId}:${attempt.id}`,
          "CANCEL_ATTEMPT",
          {
            attemptId: attempt.friendlyId,
            backgroundWorkerId: attempt.backgroundWorker.friendlyId,
            taskRunId: run.friendlyId,
          }
        );
      } else {
        switch (attempt.status) {
          case "EXECUTING": {
            // We need to send a cancel message to the coordinator
            socketIo.coordinatorNamespace.emit("REQUEST_ATTEMPT_CANCELLATION", {
              version: "v1",
              attemptId: attempt.id,
              attemptFriendlyId: attempt.friendlyId,
            });

            break;
          }
          case "PENDING":
          case "PAUSED": {
            logger.debug("Cancelling pending or paused attempt", {
              attempt,
            });

            const service = new CancelAttemptService();

            await service.call(
              attempt.friendlyId,
              run.id,
              new Date(),
              "Task run was cancelled by user"
            );

            break;
          }
          case "CANCELED":
          case "COMPLETED":
          case "FAILED": {
            // Do nothing
            break;
          }
          default: {
            assertNever(attempt.status);
          }
        }
      }
    }
  }

  async #cancelRemainingRunWorkers(run: ExtendedTaskRun) {
    if (run.runtimeEnvironment.type === "DEVELOPMENT") {
      // Nothing to do
      return;
    }

    // Broadcast cancel message to all coordinators
    socketIo.coordinatorNamespace.emit("REQUEST_RUN_CANCELLATION", {
      version: "v1",
      runId: run.id,
      // Give the attempts some time to exit gracefully. If the runs supports lazy attempts, it also supports exit delays.
      delayInMs: run.lockedToVersion?.supportsLazyAttempts ? 5_000 : undefined,
    });
  }
}
