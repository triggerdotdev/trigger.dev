import { logger, type RuntimeEnvironmentType } from "@trigger.dev/core/v3";
import { type RunEngineVersion } from "@trigger.dev/database";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { BasePresenter } from "./basePresenter.server";
import { waitpointStatusToApiStatus } from "./WaitpointListPresenter.server";
import { generateHttpCallbackUrl } from "~/services/httpCallback.server";
import type { PrismaClientOrTransaction, PrismaReplicaClient } from "~/db.server";
import { readThroughRun } from "~/v3/runOpsMigration/readThrough.server";

// When omitted, clients default to the inherited _replica handle => passthrough reads the
// replica exactly as today. isPastRetention is injectable for tests. Typed PrismaReplicaClient
// to match readThroughRun's readNew/readLegacy + deps.
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
    private readonly readThroughDeps?: ApiWaitpointPresenterReadThroughDeps
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
      // Public waitpoint retrieve. Split on: new run-ops client first, then the LEGACY
      // RUN-OPS READ REPLICA ONLY on a new-probe miss — never the legacy primary.
      // Split off (single-DB / self-host): one plain waitpoint.findFirst against the replica
      // (passthrough). The waitpointId is the residency-classifiable KSUID id (the route
      // pre-decodes the friendlyId via WaitpointId.toId).
      const hydrate = (client: PrismaReplicaClient) =>
        client.waitpoint.findFirst({
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

      const result = await readThroughRun({
        runId: waitpointId,
        environmentId: environment.id,
        readNew: (client) => hydrate(client),
        readLegacy: (replica) => hydrate(replica),
        deps: {
          splitEnabled: this.readThroughDeps?.splitEnabled,
          // Default both clients to the inherited _replica handle (declared
          // PrismaClientOrTransaction but $replica at runtime) so passthrough reads the replica
          // as today; split mode injects a distinct newClient.
          newClient: this.readThroughDeps?.newClient ?? (this._replica as PrismaReplicaClient),
          legacyReplica:
            this.readThroughDeps?.legacyReplica ?? (this._replica as PrismaReplicaClient),
          isPastRetention: this.readThroughDeps?.isPastRetention,
        },
      });

      const waitpoint =
        result.source === "new" || result.source === "legacy-replica" ? result.value : null;

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
