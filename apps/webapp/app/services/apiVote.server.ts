import { PrismaClient, prisma } from "~/db.server";

export class ApiVoteService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, identifier }: { userId: string; identifier: string }) {
    return this.#prismaClient.apiIntegrationVote.create({
      data: {
        user: {
          connect: {
            id: userId,
          },
        },
        apiIdentifier: identifier,
      },
    });
  }
}
