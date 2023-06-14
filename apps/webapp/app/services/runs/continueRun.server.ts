import { PrismaClient, prisma } from "~/db.server";

export class ContinueRunService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ runId }: { runId: string }) {}
}
