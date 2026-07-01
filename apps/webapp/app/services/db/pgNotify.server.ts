import type { z } from "zod";
import type { PrismaClient} from "~/db.server";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import type { NotificationCatalog, NotificationChannel } from "./types";

export class PgNotifyService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call<TChannel extends NotificationChannel>(
    channelName: TChannel,
    payload: z.infer<NotificationCatalog[TChannel]>
  ) {
    this.#logDebug("Sending notification", { channelName, notifyPayload: payload });

    await this.#prismaClient.$executeRaw`
      SELECT pg_notify(${channelName}, ${JSON.stringify(payload)})
    `;
  }

  #logDebug(message: string, args?: any) {
    logger.debug(`[pgNotify] ${message}`, args);
  }
}
