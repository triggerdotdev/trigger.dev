import { TaskRun, TaskRunAttempt } from "@trigger.dev/database";
import { eventRepository } from "../eventRepository.server";
import { marqs } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ResumeTaskRunDependenciesService } from "./resumeTaskRunDependencies.server";
import { CRASHABLE_ATTEMPT_STATUSES, isCrashableRunStatus } from "../taskStatus";

export type CrashTaskRunServiceOptions = {
  reason?: string;
  exitCode?: number;
  logs?: string;
  crashAttempts?: boolean;
  crashedAt?: Date;
  overrideCompletion?: boolean;
};

export class CrashTaskRunService extends BaseService {
  public async call(runId: string, options?: CrashTaskRunServiceOptions) {
    const opts = {
      reason: "Worker crashed",
      crashAttempts: true,
      crashedAt: new Date(),
      ...options,
    };

    const taskRun = await this._prisma.taskRun.findFirst({
      where: {
        id: runId,
      },
    });

    if (!taskRun) {
      logger.error("Task run not found", { runId });
      return;
    }

    // Make sure the task run is in a crashable state
    if (!opts.overrideCompletion && !isCrashableRunStatus(taskRun.status)) {
      logger.error("Task run is not in a crashable state", { runId, status: taskRun.status });
      return;
    }

    // Remove the task run from the queue if it's there for some reason
    await marqs?.acknowledgeMessage(taskRun.id);

    // Set the task run status to crashed
    const crashedTaskRun = await this._prisma.taskRun.update({
      where: {
        id: taskRun.id,
      },
      data: {
        status: "CRASHED",
      },
      include: {
        attempts: {
          where: {
            status: {
              in: CRASHABLE_ATTEMPT_STATUSES,
            },
          },
          include: {
            backgroundWorker: true,
            runtimeEnvironment: true,
          },
        },
        dependency: true,
        runtimeEnvironment: {
          include: {
            organization: true,
            project: true,
          },
        },
      },
    });

    const inProgressEvents = await eventRepository.queryIncompleteEvents({
      runId: taskRun.friendlyId,
    });

    logger.debug("Crashing in-progress events", {
      inProgressEvents: inProgressEvents.map((event) => event.id),
    });

    await Promise.all(
      inProgressEvents.map((event) => {
        return eventRepository.crashEvent({
          event: event,
          crashedAt: opts.crashedAt,
          exception: {
            type: "Worker crashed",
            message: opts.reason,
            stacktrace: opts.logs,
          },
        });
      })
    );

    if (!opts.crashAttempts) {
      return;
    }

    // Cancel any in progress attempts
    for (const attempt of crashedTaskRun.attempts) {
      await this.#failAttempt(
        attempt,
        crashedTaskRun,
        new Date(),
        crashedTaskRun.runtimeEnvironment
      );
    }
  }

  async #failAttempt(
    attempt: TaskRunAttempt,
    run: TaskRun,
    failedAt: Date,
    environment: AuthenticatedEnvironment
  ) {
    return await this.traceWithEnv("failAttempt()", environment, async (span) => {
      span.setAttribute("taskRunId", run.id);
      span.setAttribute("attemptId", attempt.id);

      await marqs?.acknowledgeMessage(run.id);

      await this._prisma.taskRunAttempt.update({
        where: {
          id: attempt.id,
        },
        data: {
          status: "FAILED",
          completedAt: failedAt,
        },
      });

      if (environment.type === "DEVELOPMENT") {
        return;
      }

      await ResumeTaskRunDependenciesService.enqueue(attempt.id, this._prisma);
    });
  }
}
