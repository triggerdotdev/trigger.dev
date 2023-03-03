import { SubscribeInput, SubscribeResult } from "core/webhook/subscribe/types";
import { prisma, PrismaClient } from "db/db.server";

export class SubscribeToWebhook {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(input: SubscribeInput): Promise<SubscribeResult> {
    return;
  }
}
