import { HttpEndpoint, HttpService } from "../services";
import {
  DisplayProperties,
  CacheService,
  PerformedRequestResponse,
  PerformRequestOptions,
  RequestIntegration,
  AccessInfo,
} from "../types";
import { slack } from "internal-providers";

import debug from "debug";
import { getAccessToken } from "../accessInfo";

const log = debug("trigger:integrations:slack");

class SlackRequestIntegration implements RequestIntegration {
  #joinChannelEndpoint = new HttpEndpoint<
    typeof slack.schemas.JoinConversationResponseSchema,
    typeof slack.schemas.JoinConversationBodySchema
  >({
    response: slack.schemas.JoinConversationResponseSchema,
    method: "POST",
    path: "/conversations.join",
  });

  #listConversationsEndpoint = new HttpEndpoint({
    response: slack.schemas.ListConversationsResponseSchema,
    method: "GET",
    path: "/conversations.list",
  });

  #postMessageEndpoint = new HttpEndpoint<
    typeof slack.schemas.PostMessageResponseSchema,
    typeof slack.schemas.PostMessageBodySchema
  >({
    response: slack.schemas.PostMessageResponseSchema,
    method: "POST",
    path: "/chat.postMessage",
  });

  constructor(private readonly baseUrl: string = "https://slack.com/api") {}

  perform(options: PerformRequestOptions): Promise<PerformedRequestResponse> {
    switch (options.endpoint) {
      case "chat.postMessage": {
        return this.#postMessage(
          options.accessInfo,
          options.params,
          options.cache
        );
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
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService
  ): Promise<PerformedRequestResponse> {
    const parsedParams = slack.schemas.PostMessageBodySchema.parse(params);

    log("chat.postMessage %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: this.baseUrl,
    });

    const channel = await this.#findChannelId(
      service,
      parsedParams.channel,
      cache
    );

    log("found channelId %s", channel);

    const response = await service.performRequest(this.#postMessageEndpoint, {
      ...parsedParams,
      channel,
    });

    if (!response.success) {
      log("chat.postMessage failed %O", response);

      return {
        ok: false,
        isRetryable: this.#isRetryable(response.statusCode),
        response: {
          output: null,
          context: {
            statusCode: response.statusCode,
            headers: response.headers,
          },
        },
      };
    }

    if (!response.data.ok && response.data.error === "not_in_channel") {
      log(
        "chat.postMessage failed with not_in_channel, attempting to join channel %s",
        channel
      );

      // Attempt to join the channel, and then retry the request
      const joinResponse = await service.performRequest(
        this.#joinChannelEndpoint,
        {
          channel,
        }
      );

      if (joinResponse.success && joinResponse.data.ok) {
        log("joined channel %s, retrying postMessage", channel);

        return this.#postMessage(accessInfo, params);
      }
    }

    const ok = response.data.ok;

    const performedRequest = {
      ok,
      isRetryable: this.#isRetryable(response.statusCode),
      response: {
        output: response.data,
        context: {
          statusCode: response.statusCode,
          headers: response.headers,
        },
      },
    };

    log("chat.postMessage performedRequest %O", performedRequest);

    return performedRequest;
  }

  #isRetryable(statusCode: number): boolean {
    return (
      statusCode === 408 ||
      statusCode === 429 ||
      statusCode === 500 ||
      statusCode === 502 ||
      statusCode === 503 ||
      statusCode === 504
    );
  }

  // Will use the conversations.list API (using fetch) to find the channel ID
  // unless the channel is already provided in the format of a channelID (for example: "D8572TUFR" or "C01BQJZLJGZ")
  async #findChannelId(
    service: HttpService,
    channel: string,
    cache?: CacheService
  ): Promise<string> {
    if (channel.startsWith("C") || channel.startsWith("D")) {
      return channel;
    }

    const cachedChannelId = await cache?.get(channel);

    if (cachedChannelId) {
      return cachedChannelId;
    }

    const response = await service.performRequest(
      this.#listConversationsEndpoint
    );

    if (response.success && response.data.ok) {
      const { channels } = response.data;

      const channelInfo = channels.find((c: any) => c.name === channel);

      if (channelInfo) {
        await cache?.set(channel, channelInfo.id, 60 * 60 * 24);
      }

      return channelInfo?.id || channel;
    }

    return channel;
  }
}

export const requests = new SlackRequestIntegration();
