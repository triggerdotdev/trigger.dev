import { Prisma, TaskRun, TaskRunAttemptStatus, TaskRunStatus } from "@trigger.dev/database";
import { eventRepository } from "../eventRepository.server";
import { marqs } from "~/v3/marqs/index.server";
import { devPubSub } from "../marqs/devPubSub.server";
import { BaseService } from "./baseService.server";
import { socketIo } from "../handleSocketIo.server";
import { assertUnreachable } from "../utils/asserts.server";
import { CancelAttemptService } from "./cancelAttempt.server";
import { logger } from "~/services/logger.server";

export const CANCELLABLE_STATUSES: Array<TaskRunStatus> = [
  "PENDING",
  "EXECUTING",
  "PAUSED",
  "WAITING_TO_RESUME",
  "PAUSED",
  "RETRYING_AFTER_FAILURE",
];

const CANCELLABLE_ATTEMPT_STATUSES: Array<TaskRunAttemptStatus> = [
  "EXECUTING",
  "PAUSED",
  "PENDING",
];

type ExtendedTaskRunAttempt = Prisma.TaskRunAttemptGetPayload<{
  include: {
    runtimeEnvironment: true;
    backgroundWorker: true;
  };
}>;

export type CancelTaskRunServiceOptions = {
  reason?: string;
  cancelAttempts?: boolean;
  hasCrashed?: boolean;
  cancelledAt?: Date;
};

export class CancelTaskRunService extends BaseService {
  public async call(taskRun: TaskRun, options?: CancelTaskRunServiceOptions) {
    const opts = {
      reason: "Task run was cancelled by user",
      cancelAttempts: true,
      hasCrashed: false,
      cancelledAt: new Date(),
      ...options,
    };

    // Make sure the task run is in a cancellable state
    if (!CANCELLABLE_STATUSES.includes(taskRun.status)) {
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
            runtimeEnvironment: true,
          },
        },
        dependency: true,
        runtimeEnvironment: true,
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
      if (opts.hasCrashed) {
        await this.#cancelCrashedAttempts(cancelledTaskRun, cancelledTaskRun.attempts, opts.reason);
      } else {
        await this.#cancelPotentiallyRunningAttempts(cancelledTaskRun, cancelledTaskRun.attempts);
      }
    }
  }

  async #cancelCrashedAttempts(run: TaskRun, attempts: ExtendedTaskRunAttempt[], reason: string) {
    for (const attempt of attempts) {
      const service = new CancelAttemptService();
      await service.call(attempt.friendlyId, run.id, new Date(), reason);
    }
  }

  async #cancelPotentiallyRunningAttempts(run: TaskRun, attempts: ExtendedTaskRunAttempt[]) {
    for (const attempt of attempts) {
      if (attempt.runtimeEnvironment.type === "DEVELOPMENT") {
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
            assertUnreachable(attempt.status);
          }
        }
      }
    }
  }
}
