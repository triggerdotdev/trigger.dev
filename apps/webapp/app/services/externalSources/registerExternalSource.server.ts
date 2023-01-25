import type { APIConnection, ExternalSource } from ".prisma/client";
import type { AccessInfo } from "internal-integrations";
import { github } from "internal-integrations";
import crypto from "node:crypto";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import {
  buildExternalSourceUrl,
  findExternalSourceById,
} from "~/models/externalSource.server";
import { getAccessInfo } from "../accessInfo.server";

export class RegisterExternalSource {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(idOrExternalSource: string | ExternalSource) {
    const externalSource = await this.#findExternalSource(idOrExternalSource);

    if (!externalSource) {
      return true;
    }

    if (externalSource.status === "READY") {
      return true;
    }

    if (externalSource.manualRegistration) {
      return true;
    }

    console.log("[RegisterExternalSource] registering external source", {
      externalSource,
    });

    switch (externalSource.type) {
      case "WEBHOOK": {
        return this.#registerWebhook(externalSource, externalSource.connection);
      }
      case "EVENT_BRIDGE": {
        return this.#registerEventBridge(externalSource);
      }
      case "HTTP_POLLING": {
        return this.#registerHttpPolling(externalSource);
      }
    }
  }

  async #registerWebhook(
    externalSource: ExternalSource,
    connection?: APIConnection | null
  ) {
    if (!connection) {
      return true; // Somehow the connection slot was deleted, so by returning true we're saying we're done with this webhook
    }

    const accessInfo = await getAccessInfo(connection);
    if (accessInfo == null) {
      throw new Error("No access token found for webhook");
    }

    const secret =
      externalSource.secret ?? crypto.randomBytes(32).toString("hex");

    const webhookUrl = buildExternalSourceUrl(
      externalSource,
      connection.apiIdentifier
    );

    const serviceWebhook = await this.#registerWebhookWithConnection(
      externalSource.service,
      accessInfo,
      webhookUrl,
      secret,
      externalSource.source
    );

    await this.#prismaClient.externalSource.update({
      where: {
        id: externalSource.id,
      },
      data: {
        status: "READY",
        readyAt: new Date(),
        externalData: serviceWebhook,
        secret,
      },
    });

    await this.#prismaClient.workflow.updateMany({
      where: {
        externalSourceId: externalSource.id,
      },
      data: {
        status: "READY",
      },
    });

    return true;
  }

  async #registerEventBridge(externalSource: ExternalSource) {
    return true;
  }

  async #registerHttpPolling(externalSource: ExternalSource) {
    return true;
  }

  async #findExternalSource(idOrExternalSource: string | ExternalSource) {
    const externalSource =
      typeof idOrExternalSource === "string"
        ? await findExternalSourceById(idOrExternalSource)
        : await findExternalSourceById(idOrExternalSource.id);

    if (!externalSource) {
      return;
    }

    return externalSource;
  }

  async #registerWebhookWithConnection(
    serviceIdentifier: string,
    accessInfo: AccessInfo,
    callbackUrl: string,
    secret: string,
    data: unknown
  ) {
    switch (serviceIdentifier) {
      case "github": {
        return github.webhooks.registerWebhook(
          {
            callbackUrl,
            secret,
            accessInfo,
          },
          data
        );
      }
      default: {
        throw new Error(
          `Could not register webhook with unsupported service identifier: ${serviceIdentifier}`
        );
      }
    }
  }
}
