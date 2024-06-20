import { Prisma, TaskRun } from "@trigger.dev/database";
import assertNever from "assert-never";
import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";
import { eventRepository } from "../eventRepository.server";
import { socketIo } from "../handleSocketIo.server";
import { devPubSub } from "../marqs/devPubSub.server";
import { BaseService } from "./baseService.server";
import { CancelAttemptService } from "./cancelAttempt.server";
import { CANCELLABLE_ATTEMPT_STATUSES, isCancellableRunStatus } from "../taskStatus";

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
};

export class CancelTaskRunService extends BaseService {
  public async call(taskRun: TaskRun, options?: CancelTaskRunServiceOptions) {
    const opts = {
      reason: "Task run was cancelled by user",
      cancelAttempts: true,
      cancelledAt: new Date(),
      ...options,
    };

    // Make sure the task run is in a cancellable state
    if (!isCancellableRunStatus(taskRun.status)) {
      logger.error("Task run is not in a cancellable state", {
        runId: taskRun.id,
        status: taskRun.status,
      });
      return;
    }

    // Remove the task run from the queue if it's there for some reason
    await marqs?.acknowledgeMessage(taskRun.id);

    // Set the task run status to cancelled
    const cancelledTaskRun = await this._prisma.taskRun.update({
      where: {
        id: taskRun.id,
      },
      data: {
        status: "CANCELED",
      },
      include: {
        attempts: {
          where: {
            status: {
              in: CANCELLABLE_ATTEMPT_STATUSES,
            },
          },
          include: {
            backgroundWorker: true,
          },
        },
        runtimeEnvironment: true,
        lockedToVersion: true,
      },
    });

    const inProgressEvents = await eventRepository.queryIncompleteEvents({
      runId: taskRun.friendlyId,
    });

    logger.debug("Cancelling in-progress events", {
      inProgressEvents: inProgressEvents.map((event) => event.id),
    });

    await Promise.all(
      inProgressEvents.map((event) => {
        return eventRepository.cancelEvent(event, opts.cancelledAt, opts.reason);
      })
    );

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
