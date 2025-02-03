import { TaskRunExecutionResult } from "@trigger.dev/core/v3";
import { executionResultForTaskRun } from "~/models/taskRun.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BasePresenter } from "./basePresenter.server";

export class ApiRunResultPresenter extends BasePresenter {
  public async call(
    friendlyId: string,
    env: AuthenticatedEnvironment
  ): Promise<TaskRunExecutionResult | undefined> {
    return this.traceWithEnv("call", env, async (span) => {
      const taskRun = await this._prisma.taskRun.findFirst({
        where: {
          friendlyId,
          runtimeEnvironmentId: env.id,
        },
        include: {
          attempts: {
            orderBy: {
              createdAt: "desc",
            },
          },
        },
      });

      if (!taskRun) {
        return undefined;
      }

      return executionResultForTaskRun(taskRun);
    });
  }
}
