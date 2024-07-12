import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";

export class DeleteEndpointService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string, userId: string): Promise<void> {
    await this.#prismaClient.endpoint.update({
      data: {
        url: null,
      },
      where: {
        id,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });
  }
}
