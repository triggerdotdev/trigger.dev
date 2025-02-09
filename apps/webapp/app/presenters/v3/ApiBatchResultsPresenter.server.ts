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
              taskRun: {
                include: {
                  attempts: {
                    orderBy: {
                      createdAt: "desc",
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!batchRun) {
        return undefined;
      }

      return {
        id: batchRun.friendlyId,
        items: batchRun.items
          .map((item) => executionResultForTaskRun(item.taskRun))
          .filter(Boolean),
      };
    });
  }
}
