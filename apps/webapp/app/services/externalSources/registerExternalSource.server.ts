import type { APIConnection, ExternalSource } from ".prisma/client";
import { github } from "internal-integrations";
import crypto from "node:crypto";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { findExternalSourceById } from "~/models/externalSource.server";
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

    if (!externalSource.connection) {
      return true; // Somehow the connection slot was deleted, so by returning true we're saying we're done with this webhook
    }

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
    connection: APIConnection
  ) {
    const accessToken = await getAccessInfo(connection);
    if (accessToken == null) {
      throw new Error("No access token found for webhook");
    }

    const secret = crypto.randomBytes(32).toString("hex");

    const webhookUrl = `${env.APP_ORIGIN}/api/v1/internal/webhooks/${connection.apiIdentifier}/${externalSource.id}`;

    const serviceWebhook = await this.#registerWebhookWithConnection(
      externalSource.service,
      accessToken,
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

    if (!externalSource.connection) {
      return;
    }

    return externalSource;
  }

  async #registerWebhookWithConnection(
    serviceIdentifier: string,
    accessToken: string,
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
            accessToken,
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
