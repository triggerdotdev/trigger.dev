import { ProjectAlertChannel, ProjectAlertType } from "@trigger.dev/database";
import { findProjectByRef } from "~/models/project.server";
import { omit } from "~/utils/objects";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import { BaseService, ServiceValidationError } from "../baseService.server";
import { encryptSecret } from "~/services/secrets/secretStore.server";
import { env } from "~/env.server";
import { nanoid } from "nanoid";

export type CreateAlertChannelOptions = {
  name: string;
  alertTypes: ProjectAlertType[];
  deduplicationKey?: string;
  channel:
    | {
        type: "EMAIL";
        email: string;
      }
    | {
        type: "WEBHOOK";
        url: string;
        secret?: string;
      };
};

export class CreateAlertChannelService extends BaseService {
  public async call(
    projectRef: string,
    userId: string,
    options: CreateAlertChannelOptions
  ): Promise<ProjectAlertChannel> {
    const project = await findProjectByRef(projectRef, userId);

    if (!project) {
      throw new ServiceValidationError("Project not found");
    }

    const existingAlertChannel = options.deduplicationKey
      ? await this._prisma.projectAlertChannel.findUnique({
          where: {
            projectId_deduplicationKey: {
              projectId: project.id,
              deduplicationKey: options.deduplicationKey,
            },
          },
        })
      : undefined;

    if (existingAlertChannel) {
      return await this._prisma.projectAlertChannel.update({
        where: { id: existingAlertChannel.id },
        data: {
          name: options.name,
          alertTypes: options.alertTypes,
          type: options.channel.type,
          properties: await this.#createProperties(options.channel),
        },
      });
    }

    const alertChannel = await this._prisma.projectAlertChannel.create({
      data: {
        friendlyId: generateFriendlyId("alert_channel"),
        name: options.name,
        alertTypes: options.alertTypes,
        projectId: project.id,
        type: options.channel.type,
        properties: await this.#createProperties(options.channel),
        enabled: true,
        deduplicationKey: options.deduplicationKey,
        userProvidedDeduplicationKey: options.deduplicationKey ? true : false,
      },
    });

    return alertChannel;
  }

  async #createProperties(channel: CreateAlertChannelOptions["channel"]) {
    switch (channel.type) {
      case "EMAIL":
        return {
          email: channel.email,
        };
      case "WEBHOOK":
        return {
          url: channel.url,
          secret: await encryptSecret(env.ENCRYPTION_KEY, channel.secret ?? nanoid()),
        };
    }
  }
}
