import { HttpEndpoint, HttpService } from "@trigger.dev/integration-sdk";
import type {
  DisplayProperties,
  CacheService,
  PerformedRequestResponse,
  PerformRequestOptions,
  RequestIntegration,
  AccessInfo,
  ReactNode,
} from "@trigger.dev/integration-sdk";
import debug from "debug";
import { getAccessToken } from "@trigger.dev/integration-sdk";
import { z } from "zod";
import {
  AddReactionOptionsSchema,
  AddReactionResponseSchema,
  ChannelNameOrIdSchema,
  JoinConversationBodySchema,
  JoinConversationResponseSchema,
  ListConversationsResponseSchema,
  PostMessageBodySchema,
  PostMessageOptionsSchema,
  PostMessageResponseOptionsSchema,
  PostMessageResponseSchema,
} from "../schemas";

const log = debug("trigger:integrations:slack");

const SendSlackMessageRequestBodySchema = PostMessageBodySchema.extend({
  link_names: z.literal(1),
  metadata: z
    .object({ event_type: z.string(), event_payload: z.any() })
    .optional(),
});

export class SlackRequestIntegration implements RequestIntegration {
  #joinChannelEndpoint = new HttpEndpoint<
    typeof JoinConversationResponseSchema,
    typeof JoinConversationBodySchema
  >({
    response: JoinConversationResponseSchema,
    method: "POST",
    path: "/conversations.join",
  });

  #listConversationsEndpoint = new HttpEndpoint({
    response: ListConversationsResponseSchema,
    method: "GET",
    path: "/conversations.list",
  });

  #postMessageEndpoint = new HttpEndpoint<
    typeof PostMessageResponseSchema,
    typeof SendSlackMessageRequestBodySchema
  >({
    response: PostMessageResponseSchema,
    method: "POST",
    path: "/chat.postMessage",
  });

  #addReactionEndpoint = new HttpEndpoint<
    typeof AddReactionResponseSchema,
    typeof AddReactionOptionsSchema
  >({
    response: AddReactionResponseSchema,
    method: "POST",
    path: "/reactions.add",
  });

  constructor(private readonly baseUrl: string = "https://slack.com/api") {}

  perform(options: PerformRequestOptions): Promise<PerformedRequestResponse> {
    switch (options.endpoint) {
      case "chat.postMessage": {
        return this.#postMessage(
          options.accessInfo,
          options.params,
          options.cache,
          options.metadata
        );
      }
      case "chat.postMessageResponse": {
        return this.#postMessageResponse(
          options.accessInfo,
          options.params,
          options.cache,
          options.metadata
        );
      }
      case "reactions.add": {
        return this.#addReaction(
          options.accessInfo,
          options.params,
          options.cache,
          options.metadata
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
      case "chat.postMessageResponse": {
        return {
          title: `Post response`,
          properties: [],
        };
      }
      case "reactions.add": {
        return {
          title: `Add reaction to message ${params.timestamp}`,
          properties: [
            {
              key: "Reaction",
              value: params.name,
            },
          ],
        };
      }

      default: {
        throw new Error(`Unknown endpoint: ${endpoint}`);
      }
    }
  }

  renderComponent(input: any, output: any): ReactNode {
    return null;
  }

  async #postMessage(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = PostMessageOptionsSchema.parse(params);

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
      metadata: metadata
        ? { event_type: "post_message", event_payload: metadata }
        : undefined,
    });

    if (!response.success) {
      log("chat.postMessage failed %O", response);

      return {
        ok: false,
        isRetryable: this.#isRetryable(response.statusCode),
        response: {
          output: response.error,
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

  async #addReaction(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = AddReactionOptionsSchema.parse(params);

    log("reactions.add %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: this.baseUrl,
    });

    const channelId = await this.#findChannelId(service, parsedParams, cache);

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

    const response = await service.performRequest(this.#addReactionEndpoint, {
      ...parsedParams,
      // @ts-ignore
      channel: channelId,
    });

    if (!response.success) {
      log("reactions.add failed %O", response);

      return {
        ok: false,
        isRetryable: this.#isRetryable(response.statusCode),
        response: {
          output: response.error,
          context: {
            statusCode: response.statusCode,
            headers: response.headers,
          },
        },
      };
    }

    if (!response.data.ok && response.data.error === "not_in_channel") {
      log(
        "reactions.add failed with not_in_channel, attempting to join channel %s",
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
        log("joined channel %s, retrying reactions.add", channelId);

        return this.#addReaction(accessInfo, params);
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

  async #postMessageResponse(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = z
      .object({
        message: PostMessageResponseOptionsSchema,
        responseUrl: z.string(),
      })
      .parse(params);

    log("chat.postMessageResponse %O", parsedParams);

    const response = await fetch(parsedParams.responseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...parsedParams.message,
        metadata: metadata
          ? { event_type: "post_message_response", event_payload: metadata }
          : undefined,
      }),
    });

    if (!response.ok) {
      log("chat.postMessageResponse failed %O", response);

      const error = await safeGetJson(response);

      return {
        ok: false,
        isRetryable: this.#isRetryable(response.status),
        response: {
          output: error
            ? error
            : { name: `${response.status}`, message: response.statusText },
          context: {
            statusCode: response.status,
            headers: response.headers,
          },
        },
      };
    }

    const output = await safeGetJson(response);

    const performedRequest = {
      ok: response.ok,
      isRetryable: this.#isRetryable(response.status),
      response: {
        output,
        context: {
          statusCode: response.status,
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
    params: z.infer<typeof ChannelNameOrIdSchema>,
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

function safeGetJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}
