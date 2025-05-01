import { parseNaturalLanguageDuration } from "@trigger.dev/core/v3/isomorphic";
import { logger } from "~/services/logger.server";
import { runsDashboard } from "~/services/runsDashboardInstance.server";
import { workerQueue } from "~/services/worker.server";
import { commonWorker } from "../commonWorker.server";
import { BaseService } from "./baseService.server";
import { enqueueRun } from "./enqueueRun.server";
import { ExpireEnqueuedRunService } from "./expireEnqueuedRun.server";

export class EnqueueDelayedRunService extends BaseService {
  public static async enqueue(runId: string, runAt?: Date) {
    await commonWorker.enqueue({
      job: "v3.enqueueDelayedRun",
      payload: { runId },
      availableAt: runAt,
      id: `v3.enqueueDelayed:${runId}`,
    });
  }

  public static async reschedule(runId: string, runAt?: Date) {
    // We have to do this for now because it's possible that the workerQueue
    // was used when the run was first delayed, and EnqueueDelayedRunService.reschedule
    // is called from RescheduleTaskRunService, which allows the runAt to be changed
    // so if we don't dequeue the old job, we might end up with multiple jobs
    await workerQueue.dequeue(`v3.enqueueDelayedRun.${runId}`);

    await commonWorker.enqueue({
      job: "v3.enqueueDelayedRun",
      payload: { runId },
      availableAt: runAt,
      id: `v3.enqueueDelayed:${runId}`,
    });
  }

  public async call(runId: string) {
    const run = await this._prisma.taskRun.findFirst({
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
        dependency: {
          include: {
            dependentBatchRun: {
              include: {
                dependentTaskAttempt: {
                  include: {
                    taskRun: true,
                  },
                },
              },
            },
            dependentAttempt: {
              include: {
                taskRun: true,
              },
            },
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

    if (run.ttl) {
      const expireAt = parseNaturalLanguageDuration(run.ttl);

      if (expireAt) {
        await ExpireEnqueuedRunService.enqueue(run.id, expireAt);
      }
    }

    if (run.organizationId) {
      runsDashboard.emit.runEnqueuedAfterDelay({
        time: new Date(),
        run: {
          id: run.id,
          status: run.status,
          queuedAt: run.queuedAt ?? new Date(),
          updatedAt: run.updatedAt,
          createdAt: run.createdAt,
        },
        organization: {
          id: run.organizationId,
        },
        project: {
          id: run.projectId,
        },
        environment: {
          id: run.runtimeEnvironmentId,
        },
      });
    }

    await enqueueRun({
      env: run.runtimeEnvironment,
      run: run,
      dependentRun:
        run.dependency?.dependentAttempt?.taskRun ??
        run.dependency?.dependentBatchRun?.dependentTaskAttempt?.taskRun,
    });
  }
}
