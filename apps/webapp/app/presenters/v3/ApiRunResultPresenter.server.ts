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
      });

      if (!taskRun) {
        return undefined;
      }

      // Fetch attempts separately (FK removed for TaskRun partitioning)
      const attempts = await this._prisma.taskRunAttempt.findMany({
        where: { taskRunId: taskRun.id },
        orderBy: { createdAt: "desc" },
      });

      return executionResultForTaskRun(taskRun, attempts);
    });
  }
}
