import { type ProjectAlertChannel, type RuntimeEnvironmentType } from "@trigger.dev/database";
import { ProjectAlertWebhookProperties } from "~/models/projectAlert.server";
import { BaseService, ServiceValidationError } from "../baseService.server";
import {
  assertSlackIntegrationInOrganization,
  type CreateAlertChannelOptions,
} from "./createAlertChannel.server";
import { assertSafeWebhookUrl, UnsafeWebhookUrlError } from "./safeWebhookUrl.server";

export type UpdateAlertChannelOptions = Pick<CreateAlertChannelOptions, "name" | "channel"> &
  Partial<Pick<CreateAlertChannelOptions, "environmentTypes">>;

export class UpdateAlertChannelService extends BaseService {
  public async call(
    projectId: string,
    channelId: string,
    options: UpdateAlertChannelOptions,
    authorizedEnvironmentTypes: RuntimeEnvironmentType[]
  ): Promise<ProjectAlertChannel | null> {
    const existing = await this._prisma.projectAlertChannel.findFirst({
      where: { id: channelId, projectId },
      include: { project: { select: { organizationId: true } } },
    });

    if (!existing) {
      throw new ServiceValidationError("Alert channel not found");
    }

    if (existing.type !== options.channel.type) {
      throw new ServiceValidationError("Changing the channel type is not supported");
    }

    if (options.environmentTypes?.length === 0) {
      throw new ServiceValidationError("Select at least one environment");
    }

    if (options.channel.type === "SLACK" && options.channel.integrationId) {
      await assertSlackIntegrationInOrganization(
        this._prisma,
        options.channel.integrationId,
        existing.project.organizationId
      );
    }

    const properties = await this.#updateProperties(existing, options.channel);

    const updated = await this._prisma.projectAlertChannel.updateMany({
      where: {
        id: existing.id,
        projectId,
        environmentTypes: { equals: authorizedEnvironmentTypes },
      },
      data: {
        name: options.name,
        ...(options.environmentTypes && { environmentTypes: options.environmentTypes }),
        properties,
        ...(options.channel.type === "SLACK" &&
          "integrationId" in properties &&
          properties.integrationId && { integrationId: properties.integrationId }),
      },
    });
    if (updated.count === 0) {
      return null;
    }
    return this._prisma.projectAlertChannel.findFirst({ where: { id: existing.id, projectId } });
  }

  async #updateProperties(
    existing: ProjectAlertChannel,
    channel: UpdateAlertChannelOptions["channel"]
  ) {
    switch (channel.type) {
      case "EMAIL":
        return { email: channel.email };
      case "WEBHOOK": {
        try {
          await assertSafeWebhookUrl(channel.url);
        } catch (error) {
          if (error instanceof UnsafeWebhookUrlError) {
            throw new ServiceValidationError(error.message);
          }
          throw error;
        }

        const stored = ProjectAlertWebhookProperties.parse(existing.properties);
        return { ...stored, url: channel.url };
      }
      case "SLACK":
        return {
          channelId: channel.channelId,
          channelName: channel.channelName,
          integrationId: channel.integrationId ?? storedIntegrationId(existing.properties),
        };
    }
  }
}

function storedIntegrationId(properties: ProjectAlertChannel["properties"]) {
  const id = (properties as { integrationId?: unknown } | null)?.integrationId;
  return typeof id === "string" ? id : undefined;
}
