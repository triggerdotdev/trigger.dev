import { prisma, PrismaClient } from "db/db.server";
import { WebhookReceiveRequest, WebhookResult } from "../types";

export class ReceiveWebhook {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(input: WebhookReceiveRequest): Promise<WebhookResult> {
    throw new Error("Not implemented");
  }
}
