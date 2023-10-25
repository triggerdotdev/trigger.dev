import { SerializableJson } from "@trigger.dev/core";
import { PrismaClient, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";

export class PgNotifyService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(channelName: string, payload: SerializableJson) {
    this.#logDebug("Sending notification", { channelName, notifyPayload: payload });

    await this.#prismaClient.$executeRaw`
      SELECT pg_notify(${channelName}, ${JSON.stringify(payload)})
    `;
  }

  #logDebug(message: string, args?: any) {
    logger.debug(`[pgNotify] ${message}`, args);
  }
}
