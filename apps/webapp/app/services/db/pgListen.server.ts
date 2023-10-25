import { logger } from "~/services/logger.server";
import { Logger } from "@trigger.dev/core";
import type { PoolClient } from "pg";

export class PgListenService {
  #poolClient: PoolClient;
  #logger: Logger;
  #loggerNamespace: string;

  constructor(poolClient: PoolClient, loggerNamespace?: string, loggerInstance?: Logger) {
    this.#poolClient = poolClient;
    this.#logger = loggerInstance ?? logger;
    this.#loggerNamespace = loggerNamespace ?? "";
  }

  public async call(channelName: string, callback: (payload: string) => Promise<void>) {
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

      await callback(notification.payload);
    });
  }

  #logDebug(message: string, args?: any) {
    const namespace = this.#loggerNamespace ? `[${this.#loggerNamespace}]` : "";
    this.#logger.debug(`[pgListen]${namespace} ${message}`, args);
  }
}
