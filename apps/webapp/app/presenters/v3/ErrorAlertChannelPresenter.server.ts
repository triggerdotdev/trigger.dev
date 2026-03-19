import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import {
  ProjectAlertEmailProperties,
  ProjectAlertSlackProperties,
  ProjectAlertWebhookProperties,
} from "~/models/projectAlert.server";
import { BasePresenter } from "./basePresenter.server";
import { NewAlertChannelPresenter } from "./NewAlertChannelPresenter.server";
import { env } from "~/env.server";

export type ErrorAlertChannelData = Awaited<ReturnType<ErrorAlertChannelPresenter["call"]>>;

export class ErrorAlertChannelPresenter extends BasePresenter {
  public async call(projectId: string, environmentType: RuntimeEnvironmentType) {
    const channels = await this._prisma.projectAlertChannel.findMany({
      where: {
        projectId,
        alertTypes: { has: "ERROR_GROUP" },
        environmentTypes: { has: environmentType },
      },
      orderBy: { createdAt: "asc" },
    });

    const emails: Array<{ id: string; email: string }> = [];
    const webhooks: Array<{ id: string; url: string }> = [];
    let slackChannel: { id: string; channelId: string; channelName: string } | null = null;

    for (const channel of channels) {
      switch (channel.type) {
        case "EMAIL": {
          const parsed = ProjectAlertEmailProperties.safeParse(channel.properties);
          if (parsed.success) {
            emails.push({ id: channel.id, email: parsed.data.email });
          }
          break;
        }
        case "SLACK": {
          const parsed = ProjectAlertSlackProperties.safeParse(channel.properties);
          if (parsed.success) {
            slackChannel = {
              id: channel.id,
              channelId: parsed.data.channelId,
              channelName: parsed.data.channelName,
            };
          }
          break;
        }
        case "WEBHOOK": {
          const parsed = ProjectAlertWebhookProperties.safeParse(channel.properties);
          if (parsed.success) {
            webhooks.push({ id: channel.id, url: parsed.data.url });
          }
          break;
        }
      }
    }

    const slackPresenter = new NewAlertChannelPresenter(this._prisma, this._replica);
    const slackResult = await slackPresenter.call(projectId);

    const emailAlertsEnabled =
      env.ALERT_FROM_EMAIL !== undefined && env.ALERT_RESEND_API_KEY !== undefined;

    return {
      emails,
      webhooks,
      slackChannel,
      slack: slackResult.slack,
      emailAlertsEnabled,
    };
  }
}
