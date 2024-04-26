import { ProjectAlertChannel, ProjectAlertType } from "@trigger.dev/database";
import { findProjectByRef } from "~/models/project.server";
import { omit } from "~/utils/objects";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import { BaseService, ServiceValidationError } from "../baseService.server";

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
        secret: string;
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
          properties: omit(options.channel, ["type"]),
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
        properties: omit(options.channel, ["type"]),
        enabled: true,
        deduplicationKey: options.deduplicationKey,
        userProvidedDeduplicationKey: options.deduplicationKey ? true : false,
      },
    });

    return alertChannel;
  }
}
