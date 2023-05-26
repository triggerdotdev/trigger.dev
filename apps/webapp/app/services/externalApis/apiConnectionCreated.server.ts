import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { IngestSendEvent } from "../events/ingestSendEvent.server";
import { logger } from "../logger";
import { workerQueue } from "../worker.server";
import { MISSING_CONNECTION_RESOLVED_NOTIFICATION } from "@/../../packages/internal/src";

export class ApiConnectionCreatedService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    logger.debug("ApiConnectionCreatedService.call", { id });

    return await $transaction(this.#prismaClient, async (tx) => {
      // first, deliver the event through the dispatcher
      const apiConnection = await tx.apiConnection.findUniqueOrThrow({
        where: {
          id,
        },
        include: {
          externalAccount: true,
          client: true,
        },
      });

      const missingConnection = await tx.missingApiConnection.findUnique({
        where: {
          apiConnectionClientId_connectionType_externalAccountId: {
            apiConnectionClientId: apiConnection.clientId,
            connectionType: apiConnection.connectionType,
            externalAccountId: apiConnection.externalAccount
              ? apiConnection.externalAccount.id
              : "DEVELOPER",
          },
        },
        include: {
          runs: {
            include: {
              environment: {
                include: {
                  project: true,
                  organization: true,
                },
              },
            },
            orderBy: {
              createdAt: "asc",
            },
          },
          apiConnectionClient: true,
          externalAccount: true,
        },
      });

      if (!missingConnection) {
        return;
      }

      if (missingConnection.resolved) {
        return;
      }

      const firstRun = missingConnection.runs[0];

      if (!firstRun) {
        return;
      }

      const eventId = `${missingConnection.id}-resolved`;

      const eventService = new IngestSendEvent(tx);

      await eventService.call(firstRun.environment, {
        id: eventId,
        name: MISSING_CONNECTION_RESOLVED_NOTIFICATION,
        payload: {
          id: missingConnection.id,
          type: missingConnection.connectionType,
          client: {
            id: missingConnection.apiConnectionClient.slug,
            title: missingConnection.apiConnectionClient.title,
            scopes: missingConnection.apiConnectionClient.scopes,
            createdAt: missingConnection.apiConnectionClient.createdAt,
            updatedAt: missingConnection.apiConnectionClient.updatedAt,
            integrationIdentifier:
              missingConnection.apiConnectionClient.integrationIdentifier,
            integrationAuthMethod:
              missingConnection.apiConnectionClient.integrationAuthMethod,
          },
          expiresAt: apiConnection.expiresAt ?? undefined,
          account: missingConnection.externalAccount
            ? {
                id: missingConnection.externalAccount.identifier,
                metadata: missingConnection.externalAccount.metadata,
              }
            : undefined,
        },
        context: {},
      });

      await tx.missingApiConnection.delete({
        where: {
          id: missingConnection.id,
        },
      });

      for (const run of missingConnection.runs) {
        logger.debug("[ApiConnectionCreatedService] restarting run", {
          run,
        });

        // We need to start the run again
        await workerQueue.enqueue(
          "startRun",
          {
            id: run.id,
          },
          { tx }
        );
      }
    });
  }
}
