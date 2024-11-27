import { RetrieveBatchResponse } from "@trigger.dev/core/v3";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BasePresenter } from "./basePresenter.server";

export class ApiRetrieveBatchPresenter extends BasePresenter {
  public async call(
    friendlyId: string,
    env: AuthenticatedEnvironment
  ): Promise<RetrieveBatchResponse | undefined> {
    return this.traceWithEnv<RetrieveBatchResponse | undefined>("call", env, async (span) => {
      const batch = await this._replica.batchTaskRun.findFirst({
        where: {
          friendlyId,
          runtimeEnvironmentId: env.id,
        },
      });

      if (!batch) {
        return;
      }

      return {
        id: batch.friendlyId,
        status: batch.status,
        idempotencyKey: batch.idempotencyKey ?? undefined,
        createdAt: batch.createdAt,
        updatedAt: batch.updatedAt,
        runCount: batch.runCount,
      };
    });
  }
}
