import { $transaction, PrismaClientOrTransaction, prisma } from "~/db.server";
import { IngestSendEvent } from "../events/ingestSendEvent.server";
import { env } from "~/env.server";
import { MISSING_CONNECTION_NOTIFICATION } from "@/../../packages/internal/src";

export class MissingConnectionCreatedService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    return await $transaction(this.#prismaClient, async (tx) => {
      // first, deliver the event through the dispatcher
      const missingConnection = await tx.missingApiConnection.findUniqueOrThrow(
        {
          where: {
            id,
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
              take: 1,
              orderBy: {
                createdAt: "asc",
              },
            },
            externalAccount: true,
            apiConnectionClient: true,
          },
        }
      );

      if (missingConnection.resolved) {
        return;
      }

      const firstRun = missingConnection.runs[0];

      if (!firstRun) {
        return;
      }

      const eventId = missingConnection.id;

      const eventService = new IngestSendEvent(tx);

      await eventService.call(firstRun.environment, {
        id: eventId,
        name: MISSING_CONNECTION_NOTIFICATION,
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
          authorizationUrl: `${env.APP_ORIGIN}/api/missing-connections/${missingConnection.id}/authorize`, // TODO: make this real
          account: missingConnection.externalAccount
            ? {
                id: missingConnection.externalAccount.identifier,
                metadata: missingConnection.externalAccount.metadata,
              }
            : undefined,
        },
        context: {},
      });
    });
  }
}
