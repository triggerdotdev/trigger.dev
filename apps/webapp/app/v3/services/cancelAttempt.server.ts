import { runOpsLegacyPrisma, type PrismaClientOrTransaction } from "~/db.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { runStore } from "~/v3/runStore.server";
import { isCancellableRunStatus } from "../taskStatus";
import { BaseService } from "./baseService.server";
import { FinalizeTaskRunService } from "./finalizeTaskRun.server";

export class CancelAttemptService extends BaseService {
  public async call(
    attemptId: string,
    taskRunId: string,
    cancelledAt: Date,
    reason: string,
    env?: AuthenticatedEnvironment
  ) {
    let environment: AuthenticatedEnvironment | undefined = env;

    if (!environment) {
      environment = await getAuthenticatedEnvironmentFromAttempt(attemptId);

      if (!environment) {
        return;
      }
    }

    return await this.traceWithEnv("call()", environment, async (span) => {
      span.setAttribute("taskRunId", taskRunId);
      span.setAttribute("attemptId", attemptId);

      const taskRunAttempt = await this.runStore.findTaskRunAttempt(
        {
          where: {
            friendlyId: attemptId,
          },
          include: {
            taskRun: true,
          },
        },
        this._prisma
      );

      if (!taskRunAttempt) {
        return;
      }

      if (taskRunAttempt.status === "CANCELED") {
        logger.warn("Task run attempt is already cancelled", {
          attemptId,
        });

        return;
      }

      // De-forwarded from a control-plane $transaction: the attempt update lands on the
      // legacy run-ops handle (TaskRunAttempt is LEGACY_ONLY), and FinalizeTaskRunService is
      // constructed without a tx so it routes itself by residency. These are now two
      // independent writes; the loss of cross-statement atomicity is an accepted semantic.
      await runOpsLegacyPrisma.taskRunAttempt.update({
        where: {
          friendlyId: attemptId,
        },
        data: {
          status: "CANCELED",
          completedAt: cancelledAt,
        },
      });

      const isCancellable = isCancellableRunStatus(taskRunAttempt.taskRun.status);

      const finalizeService = new FinalizeTaskRunService();
      await finalizeService.call({
        id: taskRunId,
        status: isCancellable ? "INTERRUPTED" : undefined,
        completedAt: isCancellable ? cancelledAt : undefined,
        attemptStatus: isCancellable ? "CANCELED" : undefined,
        error: isCancellable ? { type: "STRING_ERROR", raw: reason } : undefined,
      });
    });
  }
}

async function getAuthenticatedEnvironmentFromAttempt(
  friendlyId: string,
  prismaClient?: PrismaClientOrTransaction
) {
  // Query split (pattern B): read the run-graph attempt scalar via the residency-aware store,
  // then resolve the control-plane environment (org/project) via the control-plane resolver
  // instead of joining `runtimeEnvironment` across the run-graph/control-plane seam.
  const taskRunAttempt = await runStore.findTaskRunAttempt(
    {
      where: {
        friendlyId,
      },
      select: {
        runtimeEnvironmentId: true,
      },
    },
    prismaClient
  );

  if (!taskRunAttempt) {
    return;
  }

  return (
    (await controlPlaneResolver.resolveAuthenticatedEnv(taskRunAttempt.runtimeEnvironmentId)) ??
    undefined
  );
}
