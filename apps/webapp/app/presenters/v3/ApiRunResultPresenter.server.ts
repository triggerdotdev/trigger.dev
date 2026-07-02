import type { TaskRunExecutionResult } from "@trigger.dev/core/v3";
import { executionResultForTaskRun } from "~/models/taskRun.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { runStore } from "~/v3/runStore.server";
import { BasePresenter } from "./basePresenter.server";

export class ApiRunResultPresenter extends BasePresenter {
  public async call(
    friendlyId: string,
    env: AuthenticatedEnvironment
  ): Promise<TaskRunExecutionResult | undefined> {
    return this.traceWithEnv("call", env, async (span) => {
      const taskRun = await runStore.findRun(
        {
          friendlyId,
          runtimeEnvironmentId: env.id,
        },
        {
          include: {
            attempts: {
              orderBy: {
                createdAt: "desc",
              },
            },
          },
        },
        this._prisma
      );

      if (!taskRun) {
        return undefined;
      }

      return executionResultForTaskRun(taskRun);
    });
  }
}
