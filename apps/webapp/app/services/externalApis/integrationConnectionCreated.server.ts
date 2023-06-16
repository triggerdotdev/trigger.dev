import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { IngestSendEvent } from "../events/ingestSendEvent.server";
import { logger } from "../logger";
import { workerQueue } from "../worker.server";
import { MISSING_CONNECTION_RESOLVED_NOTIFICATION } from "@/../../packages/internal/src";

export class IntegrationConnectionCreatedService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    logger.debug("IntegrationConnectionCreatedService.call", { id });

    return await $transaction(this.#prismaClient, async (tx) => {
      // first, deliver the event through the dispatcher
      const connection = await tx.integrationConnection.findUniqueOrThrow({
        where: {
          id,
        },
        include: {
          externalAccount: true,
          integration: true,
        },
      });

      const missingConnection = await tx.missingConnection.findUnique({
        where: {
          integrationId_connectionType_externalAccountId: {
            integrationId: connection.integrationId,
            connectionType: connection.connectionType,
            externalAccountId: connection.externalAccount
              ? connection.externalAccount.id
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
          integration: true,
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
            id: missingConnection.integration.slug,
            title: missingConnection.integration.title,
            scopes: missingConnection.integration.scopes,
            createdAt: missingConnection.integration.createdAt,
            updatedAt: missingConnection.integration.updatedAt,
          },
          expiresAt: connection.expiresAt ?? undefined,
          account: missingConnection.externalAccount
            ? {
                id: missingConnection.externalAccount.identifier,
                metadata: missingConnection.externalAccount.metadata,
              }
            : undefined,
        },
        context: {},
      });

      await tx.missingConnection.delete({
        where: {
          id: missingConnection.id,
        },
      });

      for (const run of missingConnection.runs) {
        logger.debug("[IntegrationConnectionCreatedService] restarting run", {
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
