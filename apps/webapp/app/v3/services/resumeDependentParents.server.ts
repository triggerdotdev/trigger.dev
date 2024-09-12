import { Prisma } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { isFinalAttemptStatus, isFinalRunStatus } from "../taskStatus";
import { BaseService } from "./baseService.server";
import { ResumeBatchRunService } from "./resumeBatchRun.server";
import { ResumeTaskDependencyService } from "./resumeTaskDependency.server";
import { $transaction } from "~/db.server";

type Output =
  | {
      success: true;
      action:
        | "resume-scheduled"
        | "batch-resume-scheduled"
        | "no-dependencies"
        | "not-finished"
        | "dev";
    }
  | {
      success: false;
      error: string;
    };

type Dependency = Prisma.TaskRunDependencyGetPayload<{
  include: {
    taskRun: true;
    dependentAttempt: true;
    dependentBatchRun: true;
  };
}>;

/** This will resume a dependent (parent) run if there is one and it makes sense. */
export class ResumeDependentParentsService extends BaseService {
  public async call({ id }: { id: string }): Promise<Output> {
    try {
      const dependency = await this._prisma.taskRunDependency.findFirst({
        include: {
          taskRun: {
            include: {
              runtimeEnvironment: true,
            },
          },
          dependentAttempt: true,
          dependentBatchRun: true,
        },
        where: {
          taskRunId: id,
        },
      });

      logger.log("ResumeDependentParentsService: tried to find dependency", {
        runId: id,
        dependency: dependency,
      });

      if (!dependency) {
        logger.log("ResumeDependentParentsService: dependency not found", {
          runId: id,
        });

        //no dependency, that's fine most runs won't have one.
        return {
          success: true,
          action: "no-dependencies",
        };
      }

      if (!isFinalRunStatus(dependency.taskRun.status)) {
        logger.debug(
          "ResumeDependentParentsService: run not finished yet, can't resume parent yet",
          {
            runId: id,
            dependency,
          }
        );

        // the child run isn't finished yet, so we can't resume the parent yet.
        return {
          success: true,
          action: "not-finished",
        };
      }

      if (dependency.taskRun.runtimeEnvironment.type === "DEVELOPMENT") {
        logger.debug("ResumeDependentParentsService: runs are resumed on device for DEV runs.", {
          runId: id,
          dependency,
        });

        return {
          success: true,
          action: "dev",
        };
      }

      if (dependency.dependentAttempt) {
        return this.#singleRunDependency(dependency);
      } else if (dependency.dependentBatchRun) {
        return this.#batchRunDependency(dependency);
      } else {
        logger.error("ResumeDependentParentsService: dependency has no dependencies", {
          runId: id,
          dependency,
        });

        return {
          success: false,
          error: `Dependency has no dependencies (single or batch)`,
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : JSON.stringify(error),
      };
    }
  }

  async #singleRunDependency(dependency: Dependency): Promise<Output> {
    logger.debug(
      `ResumeDependentParentsService.singleRunDependency(): Resuming dependent parent for run`,
      {
        dependency,
      }
    );

    const lastAttempt = await this._prisma.taskRunAttempt.findFirst({
      select: {
        id: true,
        status: true,
      },
      where: {
        taskRunId: dependency.taskRunId,
      },
      orderBy: {
        id: "desc",
      },
    });

    if (!lastAttempt) {
      logger.error(
        "ResumeDependentParentsService.singleRunDependency(): dependency child attempt not found",
        {
          dependency,
        }
      );

      return {
        success: false,
        error: `Dependency child attempt not found for run ${dependency.taskRunId}`,
      };
    }

    if (!isFinalAttemptStatus(lastAttempt.status)) {
      //We still want to continue if this happens because the run is final but log it
      logger.error(
        "ResumeDependentParentsService.singleRunDependency(): dependency child attempt not final, but the run is.",
        {
          dependency,
          lastAttempt,
        }
      );

      return {
        success: false,
        error: `Dependency child attempt not final, but the run is`,
      };
    }

    //resume the dependent task
    await ResumeTaskDependencyService.enqueue(dependency.id, lastAttempt.id, this._prisma);
    return {
      success: true,
      action: "resume-scheduled",
    };
  }

  async #batchRunDependency(dependency: Dependency): Promise<Output> {
    logger.debug(
      `ResumeDependentParentsService.batchRunDependency(): Resuming dependent batch for run`,
      {
        dependency,
      }
    );

    if (!dependency.dependentBatchRun) {
      logger.error(
        "ResumeDependentParentsService.batchRunDependency(): dependency has no dependent batch",
        {
          dependency,
        }
      );

      return {
        success: false,
        error: `Dependency has no dependent batch`,
      };
    }

    const lastAttempt = await this._prisma.taskRunAttempt.findFirst({
      select: {
        id: true,
        status: true,
      },
      where: {
        taskRunId: dependency.taskRunId,
      },
      orderBy: {
        id: "desc",
      },
    });

    if (!lastAttempt) {
      logger.error(
        "ResumeDependentParentsService.singleRunDependency(): dependency child attempt not found",
        {
          dependency,
        }
      );

      return {
        success: false,
        error: `Dependency child attempt not found for run ${dependency.taskRunId}`,
      };
    }

    logger.log(
      "ResumeDependentParentsService.batchRunDependency(): Setting the batchTaskRunItem to COMPLETED",
      {
        dependency,
        lastAttempt,
      }
    );

    await $transaction(this._prisma, async (tx) => {
      await tx.batchTaskRunItem.update({
        where: {
          batchTaskRunId_taskRunId: {
            batchTaskRunId: dependency.dependentBatchRun!.id,
            taskRunId: dependency.taskRunId,
          },
        },
        data: {
          status: "COMPLETED",
          taskRunAttemptId: lastAttempt.id,
        },
      });

      await ResumeBatchRunService.enqueue(dependency.dependentBatchRun!.id, tx);
    });

    return {
      success: true,
      action: "batch-resume-scheduled",
    };
  }
}
