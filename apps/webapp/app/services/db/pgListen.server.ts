import type { PoolClient } from "pg";
import { z } from "zod";
import { Logger } from "@trigger.dev/core";
import { logger } from "~/services/logger.server";
import { NotificationCatalog, NotificationChannel, notificationCatalog } from "./types";
import { safeJsonParse } from "~/utils/json";

export class PgListenService {
  #poolClient: PoolClient;
  #logger: Logger;
  #loggerNamespace: string;

  constructor(poolClient: PoolClient, loggerNamespace?: string, loggerInstance?: Logger) {
    this.#poolClient = poolClient;
    this.#logger = loggerInstance ?? logger;
    this.#loggerNamespace = loggerNamespace ?? "";
  }

  public async call<TChannel extends NotificationChannel>(
    channelName: TChannel,
    callback: (payload: z.infer<NotificationCatalog[TChannel]>) => Promise<void>
  ) {
    this.#logDebug("Registering notification handler", { channelName });

    const isValidChannel = channelName.match(/^[a-zA-Z0-9:-_]+$/);

    if (!isValidChannel) {
      throw new Error(`Invalid channel name: ${channelName}`);
    }

    this.#poolClient.query(`LISTEN "${channelName}"`).then(null, (error) => {
      this.#logDebug("LISTEN error", error);
    });

    this.#poolClient.on("notification", async (notification) => {
      if (notification.channel !== channelName) {
        return;
      }

      this.#logDebug("Notification received", { notification });

      if (!notification.payload) {
        return;
      }

      const payload = safeJsonParse(notification.payload);

      const parsedPayload = notificationCatalog[channelName].safeParse(payload);

      if (!parsedPayload.success) {
        throw new Error(
          `Failed to parse notification payload: ${channelName} - ${JSON.stringify(
            parsedPayload.error
          )}`
        );
      }

      await callback(parsedPayload.data);
    });
  }

  #logDebug(message: string, args?: any) {
    const namespace = this.#loggerNamespace ? `[${this.#loggerNamespace}]` : "";
    this.#logger.debug(`[pgListen]${namespace} ${message}`, args);
  }
}
