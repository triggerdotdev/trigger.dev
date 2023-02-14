import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

export class WorkflowRunPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(id: string) {}
}
