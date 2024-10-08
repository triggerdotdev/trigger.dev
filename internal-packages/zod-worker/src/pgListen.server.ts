import { Logger } from "@trigger.dev/core/logger";
import type { PoolClient } from "pg";
import { z } from "zod";
import { NotificationCatalog, NotificationChannel, notificationCatalog } from "./types";

export class PgListenService {
  #poolClient: PoolClient;
  #logger: Logger;
  #loggerNamespace: string;

  constructor(poolClient: PoolClient, logger: Logger, loggerNamespace?: string) {
    this.#poolClient = poolClient;
    this.#logger = logger;
    this.#loggerNamespace = loggerNamespace ?? "";
  }

  public async on<TChannel extends NotificationChannel>(
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

export function safeJsonParse(json?: string): unknown {
  if (!json) {
    return;
  }

  try {
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}
