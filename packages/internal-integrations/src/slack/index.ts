import { HttpEndpoint, HttpService } from "../services";
import {
  DisplayProperties,
  CacheService,
  PerformedRequestResponse,
  PerformRequestOptions,
  RequestIntegration,
  AccessInfo,
} from "../types";
import { slack } from "@trigger.dev/providers";
import debug from "debug";
import { getAccessToken } from "../accessInfo";
import { z } from "zod";

const log = debug("trigger:integrations:slack");

const SendSlackMessageRequestBodySchema =
  slack.schemas.PostMessageBodySchema.extend({
    link_names: z.literal(1),
  });

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
    typeof SendSlackMessageRequestBodySchema
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
          title: `Post message to ${
            "channelName" in params ? params.channelName : params.channelId
          }`,
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
    const parsedParams = slack.schemas.PostMessageOptionsSchema.parse(params);

    log("chat.postMessage %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: this.baseUrl,
    });

    const channelId = await this.#findChannelId(service, params, cache);

    if (!channelId) {
      return {
        ok: false,
        isRetryable: false,
        response: {
          output: {
            message: `channelId not found`,
          },
          context: {
            statusCode: 404,
            headers: {},
          },
        },
      };
    }

    log("found channelId %s", channelId);

    const response = await service.performRequest(this.#postMessageEndpoint, {
      ...parsedParams,
      link_names: 1,
      channel: channelId,
    });

    if (!response.success) {
      log("chat.postMessage failed %O", response);

      return {
        ok: false,
        isRetryable: this.#isRetryable(response.statusCode),
        response: {
          output: {},
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
        channelId
      );

      // Attempt to join the channel, and then retry the request
      const joinResponse = await service.performRequest(
        this.#joinChannelEndpoint,
        {
          channel: channelId,
        }
      );

      if (joinResponse.success && joinResponse.data.ok) {
        log("joined channel %s, retrying postMessage", channelId);

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
    params: z.infer<typeof slack.schemas.ChannelNameOrIdSchema>,
    cache?: CacheService
  ): Promise<string | undefined> {
    if ("channelId" in params) {
      return params.channelId;
    }

    if (!("channelName" in params)) {
      throw new Error("Invalid params, mising channelId and channelName");
    }

    //if the channelName starts with a #, remove it
    if (params.channelName.startsWith("#")) {
      params.channelName = params.channelName.substring(1);
    }

    const cachedChannelId = await cache?.get(params.channelName);

    if (cachedChannelId) {
      return cachedChannelId;
    }

    const response = await service.performRequest(
      this.#listConversationsEndpoint
    );

    if (response.success && response.data.ok) {
      const { channels } = response.data;

      const channelInfo = channels.find(
        (c: any) => c.name === params.channelName
      );

      if (channelInfo) {
        await cache?.set(params.channelName, channelInfo.id, 60 * 60 * 24);
        return channelInfo.id;
      }
    }

    return undefined;
  }
}

export const requests = new SlackRequestIntegration();
