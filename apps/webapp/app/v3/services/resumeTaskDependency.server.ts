import type { TaskRunDependency } from "@trigger.dev/database";
import type { RunStore } from "@internal/run-store";
import { runOpsLegacyPrisma, type PrismaClientOrTransaction } from "~/db.server";
import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";
import type { ControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { controlPlaneResolver as defaultControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { commonWorker } from "../commonWorker.server";
import { BaseService } from "./baseService.server";
import { isV3Disabled } from "../engineDeprecation.server";

export class ResumeTaskDependencyService extends BaseService {
  #controlPlaneResolver: ControlPlaneResolver;

  constructor(
    opts: {
      prisma?: PrismaClientOrTransaction;
      replica?: PrismaClientOrTransaction;
      runStore?: RunStore;
      controlPlaneResolver?: ControlPlaneResolver;
    } = {}
  ) {
    super(opts.prisma, opts.replica, opts.runStore);
    this.#controlPlaneResolver = opts.controlPlaneResolver ?? defaultControlPlaneResolver;
  }

  public async call(dependencyId: string, sourceTaskAttemptId: string) {
    // TaskRunDependency is V1-only (rows created solely by triggerTaskV1), so the dependency and its
    // taskRun/dependentAttempt subgraph are always cuid/legacy-resident: route via the legacy client.
    // The child run's runtimeEnvironment lives in the control-plane DB, so it is NOT joined here
    // (that would cross the run-graph <-> control-plane seam) — it is resolved out-of-band below.
    const dependency = await runOpsLegacyPrisma.taskRunDependency.findFirst({
      where: { id: dependencyId },
      include: {
        taskRun: true,
        dependentAttempt: {
          include: {
            taskRun: true,
          },
        },
      },
    });

    // Dependencies with a dependentBatchRun are handled already by the ResumeBatchRunService
    if (!dependency || !dependency.dependentAttempt) {
      return;
    }

    // v3 (engine V1) shutdown: don't resume dependencies for abandoned V1 runs. v4 is unaffected.
    if (isV3Disabled() && dependency.taskRun.engine === "V1") {
      logger.debug("[ResumeTaskDependencyService] Skipping resume for shut-down v3 run", {
        dependencyId,
      });
      return;
    }

    // Resolve the child run's environment (with its project/organization) from the control-plane
    // DB rather than cross-seam joining it off the legacy TaskRunDependency read above.
    const runtimeEnvironment = await this.#controlPlaneResolver.resolveAuthenticatedEnv(
      dependency.taskRun.runtimeEnvironmentId
    );

    if (!runtimeEnvironment) {
      throw new Error(
        `Could not resolve environment ${dependency.taskRun.runtimeEnvironmentId} for task dependency ${dependencyId}`
      );
    }

    if (runtimeEnvironment.type === "DEVELOPMENT") {
      return;
    }

    const dependentRun = dependency.dependentAttempt.taskRun;

    if (dependency.dependentAttempt.status === "PAUSED" && dependency.checkpointEventId) {
      logger.debug(
        "Task dependency resume: Attempt is paused and there's a checkpoint. Enqueuing resume with checkpoint.",
        {
          attemptId: dependency.id,
          dependentAttempt: dependency.dependentAttempt,
          checkpointEventId: dependency.checkpointEventId,
          hasCheckpointEvent: !!dependency.checkpointEventId,
          runId: dependentRun.id,
        }
      );

      const wasUpdated = await this.#setDependencyToResumedOnce(dependency);

      if (!wasUpdated) {
        logger.debug("Task dependency resume: Attempt with checkpoint was already resumed", {
          attemptId: dependency.id,
          dependentAttempt: dependency.dependentAttempt,
          checkpointEventId: dependency.checkpointEventId,
          hasCheckpointEvent: !!dependency.checkpointEventId,
          runId: dependentRun.id,
        });
        return;
      }

      // TODO: use the new priority queue thingie
      await marqs?.enqueueMessage(
        runtimeEnvironment,
        dependentRun.queue,
        dependentRun.id,
        {
          type: "RESUME",
          completedAttemptIds: [sourceTaskAttemptId],
          resumableAttemptId: dependency.dependentAttempt.id,
          checkpointEventId: dependency.checkpointEventId,
          taskIdentifier: dependency.taskRun.taskIdentifier,
          projectId: runtimeEnvironment.projectId,
          environmentId: runtimeEnvironment.id,
          environmentType: runtimeEnvironment.type,
        },
        dependentRun.concurrencyKey ?? undefined,
        dependentRun.queueTimestamp ?? dependentRun.createdAt,
        undefined,
        "resume"
      );
    } else {
      logger.debug("Task dependency resume: Attempt is not paused or there's no checkpoint event", {
        attemptId: dependency.id,
        dependentAttempt: dependency.dependentAttempt,
        checkpointEventId: dependency.checkpointEventId,
        hasCheckpointEvent: !!dependency.checkpointEventId,
        runId: dependentRun.id,
      });

      if (dependency.dependentAttempt.status === "PAUSED" && !dependency.checkpointEventId) {
        // In case of race conditions the status can be PAUSED without a checkpoint event
        // When the checkpoint is created, it will continue the run
        logger.error("Task dependency resume: Attempt is paused but there's no checkpoint event", {
          attemptId: dependency.id,
          dependentAttemptId: dependency.dependentAttempt.id,
        });
        return;
      }

      const wasUpdated = await this.#setDependencyToResumedOnce(dependency);

      if (!wasUpdated) {
        logger.debug("Task dependency resume: Attempt without checkpoint was already resumed", {
          attemptId: dependency.id,
          dependentAttempt: dependency.dependentAttempt,
          checkpointEventId: dependency.checkpointEventId,
          hasCheckpointEvent: !!dependency.checkpointEventId,
          runId: dependentRun.id,
        });
        return;
      }

      await marqs.requeueMessage(
        dependentRun.id,
        {
          type: "RESUME",
          completedAttemptIds: [sourceTaskAttemptId],
          resumableAttemptId: dependency.dependentAttempt.id,
          checkpointEventId: dependency.checkpointEventId ?? undefined,
          taskIdentifier: dependency.taskRun.taskIdentifier,
          projectId: runtimeEnvironment.projectId,
          environmentId: runtimeEnvironment.id,
          environmentType: runtimeEnvironment.type,
        },
        (dependentRun.queueTimestamp ?? dependentRun.createdAt).getTime(),
        "resume"
      );
    }
  }

  async #setDependencyToResumedOnce(dependency: TaskRunDependency) {
    // Legacy-resident write (TaskRunDependency is V1-only/cuid): land it on the legacy writer.
    const result = await runOpsLegacyPrisma.taskRunDependency.updateMany({
      where: {
        id: dependency.id,
        resumedAt: null,
      },
      data: {
        resumedAt: new Date(),
      },
    });

    // Check if any records were updated
    if (result.count > 0) {
      // The status was changed, so we return true
      return true;
    } else {
      return false;
    }
  }

  static async enqueue(dependencyId: string, sourceTaskAttemptId: string, runAt?: Date) {
    return await commonWorker.enqueue({
      job: "v3.resumeTaskDependency",
      payload: {
        dependencyId,
        sourceTaskAttemptId,
      },
      availableAt: runAt,
    });
  }
}
