import { logger } from "~/services/logger.server";
import { BasePresenter } from "./basePresenter.server";
import { RuntimeEnvironmentType, type ProjectAlertChannel } from "@trigger.dev/database";
import { decryptSecret } from "~/services/secrets/secretStore.server";
import { env } from "~/env.server";
import {
  ProjectAlertEmailProperties,
  ProjectAlertSlackProperties,
  ProjectAlertWebhookProperties,
} from "~/models/projectAlert.server";
import { getLimit } from "~/services/platform.v3.server";

export type AlertChannelListPresenterData = Awaited<ReturnType<AlertChannelListPresenter["call"]>>;
export type AlertChannelListPresenterRecord =
  AlertChannelListPresenterData["alertChannels"][number];
export type AlertChannelListPresenterAlertProperties = NonNullable<
  AlertChannelListPresenterRecord["properties"]
>;

export class AlertChannelListPresenter extends BasePresenter {
  public async call(projectId: string, environmentType?: RuntimeEnvironmentType) {
    logger.debug("AlertChannelListPresenter", { projectId });

    const alertChannels = await this._prisma.projectAlertChannel.findMany({
      where: {
        projectId,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const organization = await this._replica.project.findFirst({
      where: {
        id: projectId,
      },
      select: {
        organizationId: true,
      },
    });

    if (!organization) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const limit = await getLimit(organization.organizationId, "alerts", 100_000_000);

    const relevantChannels = alertChannels.filter((channel) => {
      if (!environmentType) return true;
      return channel.environmentTypes.includes(environmentType);
    });

    return {
      alertChannels: await Promise.all(
        relevantChannels.map(async (alertChannel) => ({
          ...alertChannel,
          properties: await this.#presentProperties(alertChannel),
        }))
      ),
      limits: {
        used: alertChannels.length,
        limit,
      },
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
