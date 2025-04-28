import {
  type AuthenticatableIntegration,
  OrgIntegrationRepository,
} from "~/models/orgIntegration.server";
import { BasePresenter } from "./basePresenter.server";
import { type WebClient } from "@slack/web-api";
import { tryCatch } from "@trigger.dev/core";
import { logger } from "~/services/logger.server";

export class NewAlertChannelPresenter extends BasePresenter {
  public async call(projectId: string) {
    const project = await this._prisma.project.findFirstOrThrow({
      where: {
        id: projectId,
      },
    });

    // Find the latest Slack integration
    const slackIntegration = await this._prisma.organizationIntegration.findFirst({
      where: {
        service: "SLACK",
        organizationId: project.organizationId,
      },
      orderBy: {
        createdAt: "desc",
      },
      include: {
        tokenReference: true,
      },
    });

    // If there is a slack integration, then we need to get a list of Slack Channels
    if (slackIntegration) {
      const [error, channels] = await tryCatch(getSlackChannelsForToken(slackIntegration));

      if (error) {
        if (isSlackError(error) && error.data.error === "token_revoked") {
          return {
            slack: {
              status: "TOKEN_REVOKED" as const,
            },
          };
        }

        if (isSlackError(error) && error.data.error === "token_expired") {
          return {
            slack: {
              status: "TOKEN_EXPIRED" as const,
            },
          };
        }

        logger.error("Failed fetching Slack channels for creating alerts", {
          error,
          slackIntegrationId: slackIntegration.id,
        });

        return {
          slack: {
            status: "FAILED_FETCHING_CHANNELS" as const,
          },
        };
      }

      return {
        slack: {
          status: "READY" as const,
          channels: channels ?? [],
          integrationId: slackIntegration.id,
        },
      };
    }

    if (OrgIntegrationRepository.isSlackSupported) {
      return {
        slack: {
          status: "NOT_CONFIGURED" as const,
        },
      };
    }

    return {
      slack: {
        status: "NOT_AVAILABLE" as const,
      },
    };
  }
}

async function getSlackChannelsForToken(integration: AuthenticatableIntegration) {
  const client = await OrgIntegrationRepository.getAuthenticatedClientForIntegration(integration);
  const channels = await getAllSlackConversations(client);

  return (channels ?? [])
    .filter((channel) => !channel.is_archived)
    .filter((channel) => channel.is_channel)
    .filter((channel) => channel.num_members)
    .sort((a, b) => a.name!.localeCompare(b.name!));
}

type Channels = Awaited<ReturnType<WebClient["conversations"]["list"]>>["channels"];

async function getAllSlackConversations(client: WebClient) {
  let nextCursor: string | undefined = undefined;
  let channels: Channels = [];

  try {
    do {
      // The `tryCatch` util runs into a type error due to self referencing.
      // So we fall back to a good old try/catch block here.
      const response = await client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        cursor: nextCursor,
        limit: 999,
      });

      channels = channels.concat(response.channels ?? []);
      nextCursor = response.response_metadata?.next_cursor;
    } while (nextCursor);
  } catch (error) {
    if (error && isSlackError(error) && error.data.error === "ratelimited") {
      logger.warn("Rate limiting issue occurred while fetching Slack channels", {
        error,
      });

      // This is a workaround to the current way we handle Slack channels for creating alerts.
      // For workspaces with a lot of channels (>10000) we might hit the rate limit for this slack endpoint,
      // as multiple requests are needed to fetch all channels.
      // We use the largest allowed page size of 999 to reduce the chance of hitting the rate limit.

      // This is mainly due to workspaces with a large number of archived channels,
      // which this slack endpoint unfortunately filters out only after fetching the page of channels without applying any filters first.
      // https://api.slack.com/methods/conversations.list#markdown

      // We expect most workspaces not to run into this issue, but if they do, we at least return some channels.
      // In the future, we might revisit the way we handle Slack channels and cache them on our side to support
      // proper searching. Until then, we track occurrences of this issue using a metric.
      return channels;
    }

    throw error;
  }

  return channels;
}

function isSlackError(obj: unknown): obj is { data: { error: string } } {
  return Boolean(
    typeof obj === "object" &&
      obj !== null &&
      "data" in obj &&
      typeof obj.data === "object" &&
      obj.data !== null &&
      "error" in obj.data &&
      typeof obj.data.error === "string"
  );
}
