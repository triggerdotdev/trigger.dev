import { logger } from "~/services/logger.server";
import { BasePresenter } from "./basePresenter.server";
import { ProjectAlertChannel } from "@trigger.dev/database";
import { decryptSecret } from "~/services/secrets/secretStore.server";
import { env } from "~/env.server";
import {
  ProjectAlertEmailProperties,
  ProjectAlertSlackProperties,
  ProjectAlertWebhookProperties,
} from "~/models/projectAlert.server";

export type AlertChannelListPresenterData = Awaited<ReturnType<AlertChannelListPresenter["call"]>>;
export type AlertChannelListPresenterRecord =
  AlertChannelListPresenterData["alertChannels"][number];
export type AlertChannelListPresenterAlertProperties = NonNullable<
  AlertChannelListPresenterRecord["properties"]
>;

export class AlertChannelListPresenter extends BasePresenter {
  public async call(projectId: string) {
    logger.debug("AlertChannelListPresenter", { projectId });

    const alertChannels = await this._prisma.projectAlertChannel.findMany({
      where: {
        projectId,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return {
      alertChannels: await Promise.all(
        alertChannels.map(async (alertChannel) => ({
          ...alertChannel,
          properties: await this.#presentProperties(alertChannel),
        }))
      ),
    };
  }

  async #presentProperties(alertChannel: ProjectAlertChannel) {
    if (!alertChannel.properties) {
      return;
    }

    switch (alertChannel.type) {
      case "WEBHOOK":
        const parsedProperties = ProjectAlertWebhookProperties.parse(alertChannel.properties);

        const secret = await decryptSecret(env.ENCRYPTION_KEY, parsedProperties.secret);

        return {
          type: "WEBHOOK" as const,
          url: parsedProperties.url,
          secret,
        };
      case "EMAIL":
        return {
          type: "EMAIL" as const,
          ...ProjectAlertEmailProperties.parse(alertChannel.properties),
        };
      case "SLACK": {
        return {
          type: "SLACK" as const,
          ...ProjectAlertSlackProperties.parse(alertChannel.properties),
        };
      }
      default:
        throw new Error(`Unsupported alert channel type: ${alertChannel.type}`);
    }
  }
}
