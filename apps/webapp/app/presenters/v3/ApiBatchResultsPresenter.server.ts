import { BatchTaskRunExecutionResult } from "@trigger.dev/core/v3";
import { executionResultForTaskRun } from "~/models/taskRun.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
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
            include: {
              taskRun: true,
            },
          },
        },
      });

      if (!batchRun) {
        return undefined;
      }

      // Fetch attempts for all task runs (FK removed for TaskRun partitioning)
      const taskRunIds = batchRun.items.map((item) => item.taskRun.id);
      const allAttempts = await this._prisma.taskRunAttempt.findMany({
        where: { taskRunId: { in: taskRunIds } },
        orderBy: { createdAt: "desc" },
      });

      // Group attempts by task run ID
      const attemptsByRunId = new Map<string, typeof allAttempts>();
      for (const attempt of allAttempts) {
        const existing = attemptsByRunId.get(attempt.taskRunId) ?? [];
        existing.push(attempt);
        attemptsByRunId.set(attempt.taskRunId, existing);
      }

      return {
        id: batchRun.friendlyId,
        items: batchRun.items
          .map((item) => executionResultForTaskRun(item.taskRun, attemptsByRunId.get(item.taskRun.id)))
          .filter(Boolean),
      };
    });
  }
}
