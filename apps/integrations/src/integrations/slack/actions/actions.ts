import { makeAdvancedAction, makeSimpleAction } from "core/action/makeAction";
import { Action } from "core/action/types";
import {
  combineSecurityScopes,
  makeInputSpec,
  makeOutputSpec,
} from "core/action/utilities";
import { CacheService } from "core/cache/types";
import { RequestData } from "core/request/types";
import endpoints from "../endpoints/endpoints";

export const conversationsList: Action = makeSimpleAction(
  endpoints.conversationsList
);

export const chatPostMessage: Action = makeAdvancedAction({
  endpoint: endpoints.chatPostMessage,
  spec: {
    input: {
      ...makeInputSpec(endpoints.chatPostMessage),
      security: combineSecurityScopes([
        endpoints.chatPostMessage.spec.endpointSpec.security,
        endpoints.conversationsList.spec.endpointSpec.security,
        endpoints.conversationsJoin.spec.endpointSpec.security,
      ]),
    },
    output: makeOutputSpec(endpoints.chatPostMessage),
  },
  action: async (data, cache, metadata) => {
    //get channel id
    const channelId = await getChannelId({
      channel: data.body.channel,
      credentials: data.credentials,
      cache,
    });

    if (!channelId) {
      return {
        success: false,
        status: 404,
        body: {
          ok: false,
          error: "channel_not_found",
        },
      };
    }

    //we add __trigger metadata so we can associate messages with workflow runs
    let bodyMetadata: {
      event_payload?: any;
      event_type: string;
    } = {
      event_type: "post_message",
    };
    if (metadata) {
      bodyMetadata = {
        ...bodyMetadata,
        event_payload: {
          ...(data.body?.metadata ?? {}),
          __trigger: metadata,
        },
      };
    } else {
      bodyMetadata = {
        ...bodyMetadata,
        event_payload: {
          ...(data.body?.metadata ?? {}),
        },
      };
    }

    const postMessageBody = {
      ...data.body,
      channel: channelId,
      metadata: metadata ? bodyMetadata : undefined,
    };

    const postResponse = await endpoints.chatPostMessage.request({
      parameters: data.parameters,
      body: postMessageBody,
      credentials: data.credentials,
    });

    //success
    if (postResponse.success) return postResponse;

    //if the bot isn't a member of the channel we want to invite
    if (postResponse.body?.error !== "not_in_channel") return postResponse;

    //join the bot to the channel
    const joinResponse = await endpoints.conversationsJoin.request({
      body: {
        channel: channelId,
      },
      credentials: data.credentials,
    });

    //if we can't join the channel, return the error
    if (!joinResponse.success) {
      return {
        success: false,
        status: 400,
        body: {
          ok: false,
          error: `failed to join channel: ${joinResponse.body?.error}`,
        },
      };
    }

    //try again now we've joined the channel
    return await endpoints.chatPostMessage.request({
      parameters: data.parameters,
      body: postMessageBody,
      credentials: data.credentials,
    });
  },
});

async function getChannelId({
  channel,
  credentials,
  cache,
}: {
  channel: string;
  credentials: RequestData["credentials"];
  cache?: CacheService;
}): Promise<string | undefined> {
  if (channel.startsWith("#")) {
    channel = channel.substring(1);
  }

  const cachedChannelId = await cache?.get(channel);
  if (cachedChannelId) {
    return cachedChannelId;
  }

  try {
    const data = await endpoints.conversationsList.request({
      parameters: {
        limit: 1000,
      },
      credentials,
    });

    if (!data.success) {
      return undefined;
    }

    //lookup by name or id
    const match = data.body.channels.find(
      (channelData: any) =>
        channelData.name === channel || channelData.id === channel
    );
    if (!match) {
      return undefined;
    }

    //cache for 24 hours
    await cache?.set(channel, match.id, 60 * 60 * 24);
    return match.id;
  } catch (e: any) {
    console.error(JSON.stringify(e, null, 2));
    return undefined;
  }
}
