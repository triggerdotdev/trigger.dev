import { prisma, PrismaClient } from "db/db.server";
import {
  WebhookIncomingRequest,
  WebhookReceiveRequest,
  WebhookResult,
} from "../types";

export class ReceiveWebhook {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    webhookId,
    request,
  }: {
    webhookId: string;
    request: WebhookIncomingRequest;
  }): Promise<WebhookResult> {
    //todo get webhook
    //todo get destination

    //if service webhook then collect together objects
    //call receive and get events
    //create deliveries and jobs in Graphile Worker
    //return response

    throw new Error("Not implemented");
  }
}
