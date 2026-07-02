import type { BatchTaskRunExecutionResult } from "@trigger.dev/core/v3";
import type { TaskRunWithAttempts } from "~/models/taskRun.server";
import { executionResultForTaskRun } from "~/models/taskRun.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { runStore } from "~/v3/runStore.server";
import { BasePresenter } from "./basePresenter.server";

export class ApiBatchResultsPresenter extends BasePresenter {
  public async call(
    friendlyId: string,
    env: AuthenticatedEnvironment
  ): Promise<BatchTaskRunExecutionResult | undefined> {
    return this.traceWithEnv("call", env, async (span) => {
      const batchRun = await this._prisma.batchTaskRun.findFirst({
        where: {
          friendlyId,
          runtimeEnvironmentId: env.id,
        },
        include: {
          items: {
            select: {
              taskRunId: true,
            },
          },
        },
      });

      if (!batchRun) {
        return undefined;
      }

      const taskRunIds = batchRun.items.map((item) => item.taskRunId);

      if (taskRunIds.length === 0) {
        return {
          id: batchRun.friendlyId,
          items: [],
        };
      }

      const taskRuns = await runStore.findRuns(
        {
          where: { id: { in: taskRunIds } },
          select: {
            id: true,
            friendlyId: true,
            status: true,
            taskIdentifier: true,
            attempts: {
              select: {
                status: true,
                output: true,
                outputType: true,
                error: true,
              },
              orderBy: {
                createdAt: "desc",
              },
            },
          },
        },
        this._prisma
      );

      const runMap = new Map(taskRuns.map((run) => [run.id, run]));

      return {
        id: batchRun.friendlyId,
        items: batchRun.items
          .map((item) => {
            const run = runMap.get(item.taskRunId);
            return run ? executionResultForTaskRun(run as TaskRunWithAttempts) : undefined;
          })
          .filter(Boolean),
      };
    });
  }
}
