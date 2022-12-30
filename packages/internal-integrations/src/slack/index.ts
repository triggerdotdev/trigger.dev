import { normalizeHeaders } from "../headers";
import {
  DisplayProperties,
  NormalizedResponse,
  PerformRequestOptions,
  RequestIntegration,
} from "../types";
import { PostMessageResponseSchema, PostMessageBodySchema } from "./schemas";

export const schemas = {
  PostMessageResponseSchema,
  PostMessageBodySchema,
};

class SlackRequestIntegration implements RequestIntegration {
  perform(options: PerformRequestOptions): Promise<NormalizedResponse> {
    switch (options.endpoint) {
      case "chat.postMessage": {
        return this.#postMessage(options.accessToken, options.params);
      }
      default: {
        throw new Error(`Unknown endpoint: ${options.endpoint}`);
      }
    }
  }

  displayProperties(endpoint: string, params: any): DisplayProperties {
    switch (endpoint) {
      case "chat.postMessage": {
        return {
          title: `Post message to #${params.channel}`,
          properties: [
            {
              key: "Text",
              value: params.text,
            },
          ],
        };
      }
      default: {
        throw new Error(`Unknown endpoint: ${endpoint}`);
      }
    }
  }

  async #postMessage(
    accessToken: string,
    params: any
  ): Promise<NormalizedResponse> {
    const parsedParams = PostMessageBodySchema.parse(params);

    const channelId = await this.#findChannelId(
      accessToken,
      parsedParams.channel
    );

    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...parsedParams,
        channel: channelId,
      }),
    });

    return {
      statusCode: response.status,
      headers: normalizeHeaders(response.headers),
      body: await response.json(),
    };
  }

  // Will use the conversations.list API (using fetch) to find the channel ID
  // unless the channel is already provided in the format of a channelID (for example: "D8572TUFR" or "C01BQJZLJGZ")
  async #findChannelId(
    accessToken: string,
    channel: string
  ): Promise<string | undefined> {
    if (channel.startsWith("C") || channel.startsWith("D")) {
      return channel;
    }

    const response = await fetch("https://slack.com/api/conversations.list", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error("Failed to fetch channels");
    }

    const { channels } = await response.json();

    const channelInfo = channels.find((c: any) => c.name === channel);

    return channelInfo?.id;
  }
}

export const requests = new SlackRequestIntegration();
