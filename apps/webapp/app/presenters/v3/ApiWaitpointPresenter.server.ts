import { type RuntimeEnvironmentType } from "@trigger.dev/core/v3";
import { type RunEngineVersion } from "@trigger.dev/database";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { BasePresenter } from "./basePresenter.server";
import { WaitpointPresenter } from "./WaitpointPresenter.server";

export class ApiWaitpointPresenter extends BasePresenter {
  public async call(
    environment: {
      id: string;
      type: RuntimeEnvironmentType;
      project: {
        id: string;
        engine: RunEngineVersion;
      };
    },
    waitpointId: string
  ) {
    return this.trace("call", async (span) => {
      const presenter = new WaitpointPresenter();
      const result = await presenter.call({
        friendlyId: waitpointId,
        environmentId: environment.id,
        projectId: environment.project.id,
      });

      if (!result) {
        throw new ServiceValidationError("Waitpoint not found");
      }

      return {
        id: result.id,
        status: result.status,
        completedAt: result.completedAt ?? undefined,
        timeoutAt: result.timeoutAt ?? undefined,
        completedAfter: result.completedAfter ?? undefined,
        idempotencyKey: result.userProvidedIdempotencyKey ? result.idempotencyKey : undefined,
        idempotencyKeyExpiresAt: result.idempotencyKeyExpiresAt ?? undefined,
        tags: result.tags ?? [],
        createdAt: result.createdAt,
        output: result.output,
        outputType: result.outputType,
        outputIsError: result.outputIsError,
      };
    });
  }
}
