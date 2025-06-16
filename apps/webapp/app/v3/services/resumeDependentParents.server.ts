import { Prisma } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { isFinalAttemptStatus, isFinalRunStatus } from "../taskStatus";
import { BaseService } from "./baseService.server";
import { ResumeBatchRunService } from "./resumeBatchRun.server";
import { ResumeTaskDependencyService } from "./resumeTaskDependency.server";
import { $transaction } from "~/db.server";
import { completeBatchTaskRunItemV3 } from "./batchTriggerV3.server";

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

const taskRunDependencySelect = {
  select: {
    id: true,
    taskRunId: true,
    taskRun: {
      select: {
        id: true,
        status: true,
        friendlyId: true,
        runtimeEnvironment: {
          select: {
            type: true,
          },
        },
      },
    },
    dependentAttempt: {
      select: {
        id: true,
      },
    },
    dependentBatchRun: {
      select: {
        id: true,
        batchVersion: true,
      },
    },
  },
} as const;

type Dependency = Prisma.TaskRunDependencyGetPayload<typeof taskRunDependencySelect>;

/** This will resume a dependent (parent) run if there is one and it makes sense. */
export class ResumeDependentParentsService extends BaseService {
  public async call({ id }: { id: string }): Promise<Output> {
    try {
      const dependency = await this._prisma.taskRunDependency.findFirst({
        ...taskRunDependencySelect,
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

      if (dependency.taskRun.runtimeEnvironment.type === "DEVELOPMENT") {
        return {
          success: true,
          action: "dev",
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
    await ResumeTaskDependencyService.enqueue(dependency.id, lastAttempt.id);
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

    if (dependency.dependentBatchRun!.batchVersion === "v3") {
      const batchTaskRunItem = await this._prisma.batchTaskRunItem.findFirst({
        where: {
          batchTaskRunId: dependency.dependentBatchRun!.id,
          taskRunId: dependency.taskRunId,
        },
      });

      if (batchTaskRunItem) {
        await completeBatchTaskRunItemV3(
          batchTaskRunItem.id,
          batchTaskRunItem.batchTaskRunId,
          this._prisma,
          true,
          lastAttempt.id
        );
      } else {
        logger.debug(
          "ResumeDependentParentsService.batchRunDependency() v3: batchTaskRunItem not found",
          {
            dependency,
            lastAttempt,
          }
        );
      }
    } else {
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

        await ResumeBatchRunService.enqueue(dependency.dependentBatchRun!.id, false, tx);
      });
    }

    return {
      success: true,
      action: "batch-resume-scheduled",
    };
  }
}
