import { type EphemeralEventDispatcherRequestBody } from '@trigger.dev/core/schemas';
import { $transaction, type PrismaClient, prisma } from "~/db.server";
import { type AuthenticatedEnvironment } from "../apiAuth.server";
import { ExpireDispatcherService } from "./expireDispatcher.server";

export class CreateEphemeralEventDispatcherService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    environment: AuthenticatedEnvironment,
    data: EphemeralEventDispatcherRequestBody
  ) {
    return await $transaction(this.#prismaClient, async (tx) => {
      const existingDispatcher = await tx.eventDispatcher.findUnique({
        where: {
          dispatchableId_environmentId: {
            dispatchableId: data.url,
            environmentId: environment.id,
          },
        },
      });

      if (existingDispatcher) {
        return existingDispatcher;
      }

      const externalAccount = data.accountId
        ? await this.#prismaClient.externalAccount.upsert({
            where: {
              environmentId_identifier: {
                environmentId: environment.id,
                identifier: data.accountId,
              },
            },
            create: {
              environmentId: environment.id,
              organizationId: environment.organizationId,
              identifier: data.accountId,
            },
            update: {},
          })
        : undefined;

      const dispatcher = await tx.eventDispatcher.create({
        data: {
          dispatchableId: data.url,
          environmentId: environment.id,
          source: data.source ?? "trigger.dev",
          payloadFilter: data.filter,
          contextFilter: data.contextFilter,
          dispatchable: { url: data.url, type: "EPHEMERAL" },
          enabled: true,
          event: typeof data.name === "string" ? [data.name] : data.name,
          manual: false,
          externalAccountId: externalAccount?.id,
        },
      });

      await ExpireDispatcherService.enqueue(dispatcher.id, data.timeoutInSeconds, tx);

      return dispatcher;
    });
  }
}
