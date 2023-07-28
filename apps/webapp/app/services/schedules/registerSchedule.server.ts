import { RegisterScheduleBody } from "@trigger.dev/core";
import { $transaction, PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { RegisterScheduleSourceService } from "./registerScheduleSource.server";

export class RegisterScheduleService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environment,
    payload,
    endpointSlug,
    id,
  }: {
    environment: AuthenticatedEnvironment;
    payload: RegisterScheduleBody;
    id: string;
    endpointSlug: string;
  }) {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        environmentId_slug: {
          environmentId: environment.id,
          slug: endpointSlug,
        },
      },
    });

    const dynamicTrigger =
      await this.#prismaClient.dynamicTrigger.findUniqueOrThrow({
        where: {
          endpointId_slug_type: {
            endpointId: endpoint.id,
            slug: id,
            type: "SCHEDULE",
          },
        },
      });

    const eventDispatcher =
      await this.#prismaClient.eventDispatcher.findUniqueOrThrow({
        where: {
          dispatchableId_environmentId: {
            dispatchableId: dynamicTrigger.id,
            environmentId: environment.id,
          },
        },
      });

    return await $transaction(this.#prismaClient, async (tx) => {
      const registerScheduleSource = new RegisterScheduleSourceService(tx);

      const registration = await registerScheduleSource.call({
        key: payload.id,
        dispatcher: eventDispatcher,
        schedule: payload,
        accountId: payload.accountId,
        dynamicTrigger,
      });

      return registration;
    });
  }
}
