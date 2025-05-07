import { logger, type RuntimeEnvironmentType } from "@trigger.dev/core/v3";
import { type RunEngineVersion } from "@trigger.dev/database";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { BasePresenter } from "./basePresenter.server";
import { waitpointStatusToApiStatus } from "./WaitpointListPresenter.server";
import { generateHttpCallbackUrl } from "~/services/httpCallback.server";

export class ApiWaitpointPresenter extends BasePresenter {
  public async call(
    environment: {
      id: string;
      type: RuntimeEnvironmentType;
      project: {
        id: string;
        engine: RunEngineVersion;
      };
      apiKey: string;
    },
    waitpointId: string
  ) {
    return this.trace("call", async (span) => {
      const waitpoint = await this._replica.waitpoint.findFirst({
        where: {
          id: waitpointId,
          environmentId: environment.id,
        },
        select: {
          id: true,
          friendlyId: true,
          type: true,
          status: true,
          idempotencyKey: true,
          userProvidedIdempotencyKey: true,
          idempotencyKeyExpiresAt: true,
          inactiveIdempotencyKey: true,
          output: true,
          outputType: true,
          outputIsError: true,
          completedAfter: true,
          completedAt: true,
          createdAt: true,
          connectedRuns: {
            select: {
              friendlyId: true,
            },
            take: 5,
          },
          tags: true,
        },
      });

      if (!waitpoint) {
        logger.error(`WaitpointPresenter: Waitpoint not found`, {
          id: waitpointId,
        });
        throw new ServiceValidationError("Waitpoint not found");
      }

      let isTimeout = false;
      if (waitpoint.outputIsError && waitpoint.output) {
        isTimeout = true;
      }

      return {
        id: waitpoint.friendlyId,
        type: waitpoint.type,
        url: generateHttpCallbackUrl(waitpoint.id, environment.apiKey),
        status: waitpointStatusToApiStatus(waitpoint.status, waitpoint.outputIsError),
        idempotencyKey: waitpoint.idempotencyKey,
        userProvidedIdempotencyKey: waitpoint.userProvidedIdempotencyKey,
        idempotencyKeyExpiresAt: waitpoint.idempotencyKeyExpiresAt ?? undefined,
        inactiveIdempotencyKey: waitpoint.inactiveIdempotencyKey ?? undefined,
        output: waitpoint.output ?? undefined,
        outputType: waitpoint.outputType,
        outputIsError: waitpoint.outputIsError,
        timeoutAt: waitpoint.completedAfter ?? undefined,
        completedAfter: waitpoint.completedAfter ?? undefined,
        completedAt: waitpoint.completedAt ?? undefined,
        createdAt: waitpoint.createdAt,
        tags: waitpoint.tags,
      };
    });
  }
}
