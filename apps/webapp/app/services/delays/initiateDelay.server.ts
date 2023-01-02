import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

export class InitiateDelay {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(runId: string, delay: { id: string; seconds: number }) {}
}
