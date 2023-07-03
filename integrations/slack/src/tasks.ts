import type {
  Block,
  KnownBlock,
  MessageAttachment,
  MessageMetadata,
  WebAPIPlatformError,
} from "@slack/web-api";
import { clientFactory } from "./client";
import type { AuthenticatedTask } from "@trigger.dev/sdk";

type SlackClientType = ReturnType<typeof clientFactory>;

export type ChatPostMessageArguments = {
  channel: string;
  text?: string;
  as_user?: boolean;
  attachments?: MessageAttachment[];
  blocks?: (KnownBlock | Block)[];
  icon_emoji?: string;
  icon_url?: string;
  metadata?: MessageMetadata;
  link_names?: boolean;
  mrkdwn?: boolean;
  parse?: "full" | "none";
  reply_broadcast?: boolean;
  thread_ts?: string;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
  username?: string;
};

function isPlatformError(error: unknown): error is WebAPIPlatformError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "slack_webapi_platform_error"
  );
}

export const postMessage: AuthenticatedTask<
  ReturnType<typeof clientFactory>,
  ChatPostMessageArguments,
  Awaited<ReturnType<SlackClientType["chat"]["postMessage"]>>
> = {
  run: async (params, client, task, io, auth) => {
    try {
      const response = await client.chat.postMessage(params);

      return response;
    } catch (error) {
      if (isPlatformError(error)) {
        if (error.data.error === "not_in_channel") {
          // @ts-ignore
          const joinResponse = await io.runTask<ConversationsJoinResponse>(
            `Join ${params.channel}`,
            joinConversation.init(params),
            // @ts-ignore
            async (t, io) => {
              const subResponse = await joinConversation.run(
                { channel: params.channel },
                client,
                t,
                io,
                auth
              );

              return subResponse;
            }
          );

          if (joinResponse.ok) {
            const response = await client.chat.postMessage(params);

            return response;
          }
        }
      }

      throw error;
    }
  },
  init: (params) => {
    return {
      name: "Post Message",
      params,
      icon: "slack",
      properties: [
        {
          label: "Channel ID",
          text: params.channel,
        },
        ...(params.text ? [{ label: "Message", text: params.text }] : []),
      ],
    };
  },
};

type ConversationsJoinResponse = Awaited<
  ReturnType<SlackClientType["conversations"]["join"]>
>;

export const joinConversation: AuthenticatedTask<
  ReturnType<typeof clientFactory>,
  { channel: string },
  ConversationsJoinResponse
> = {
  run: async (params, client, task, io, auth) => {
    const response = await client.conversations.join(params);

    return response;
  },
  init: (params) => {
    return {
      name: "Join Channel",
      params,
      icon: "slack",
      properties: [
        {
          label: "Channel ID",
          text: params.channel,
        },
      ],
    };
  },
};
