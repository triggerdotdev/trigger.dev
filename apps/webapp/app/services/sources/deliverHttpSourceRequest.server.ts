import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

export class DeliverHttpSourceRequestService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const httpSourceRequest =
      await this.#prismaClient.httpSourceRequestDelivery.findUniqueOrThrow({
        where: { id },
        include: {
          endpoint: true,
          environment: {
            include: {
              organization: true,
              project: true,
            },
          },
          source: {
            include: {
              secretReference: true,
            },
          },
        },
      });

    if (!httpSourceRequest.source.active) {
      return;
    }

    // TODO: implement delivering http source requests
  }
}
