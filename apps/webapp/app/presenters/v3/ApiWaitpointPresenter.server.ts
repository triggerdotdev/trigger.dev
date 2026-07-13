import { logger, type RuntimeEnvironmentType } from "@trigger.dev/core/v3";
import { type RunEngineVersion } from "@trigger.dev/database";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { BasePresenter } from "./basePresenter.server";
import { waitpointStatusToApiStatus } from "./WaitpointListPresenter.server";
import { generateHttpCallbackUrl } from "~/services/httpCallback.server";
import type { PrismaClientOrTransaction, PrismaReplicaClient } from "~/db.server";
import { runStore as defaultRunStore } from "~/v3/runStore.server";

// Retained only to preserve the public constructor signature the route passes. Run-ops routing
// (NEW vs LEGACY residency, replica reads) is now handled inside the injected `runStore`, so
// these deps are no longer consulted for the read.
type ApiWaitpointPresenterReadThroughDeps = {
  newClient?: PrismaReplicaClient;
  legacyReplica?: PrismaReplicaClient;
  splitEnabled?: boolean;
  isPastRetention?: (id: string) => boolean;
};

export class ApiWaitpointPresenter extends BasePresenter {
  constructor(
    prismaClient?: PrismaClientOrTransaction,
    replicaClient?: PrismaClientOrTransaction,
    private readonly readThroughDeps?: ApiWaitpointPresenterReadThroughDeps,
    private readonly runStore = defaultRunStore
  ) {
    super(prismaClient, replicaClient);
  }

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
      // The store routes by the waitpointId's residency (id shape) and reads the owning
      // store's replica. waitpointId is pre-decoded from the friendlyId via WaitpointId.toId.
      const waitpoint = await this.runStore.findWaitpoint({
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
          tags: true,
        },
      });

      if (!waitpoint) {
        logger.error(`WaitpointPresenter: Waitpoint not found`, {
          id: waitpointId,
        });
        throw new ServiceValidationError("Waitpoint not found");
      }

      let _isTimeout = false;
      if (waitpoint.outputIsError && waitpoint.output) {
        _isTimeout = true;
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
