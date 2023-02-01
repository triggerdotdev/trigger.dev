import { HttpEndpoint, HttpService } from "@trigger.dev/integration-sdk";
import type {
  DisplayProperties,
  CacheService,
  PerformedRequestResponse,
  PerformRequestOptions,
  RequestIntegration,
  AccessInfo,
} from "@trigger.dev/integration-sdk";
import debug from "debug";
import { getAccessToken } from "@trigger.dev/integration-sdk";
import { z } from "zod";
import {
  SendTemplateMessageBodySchema,
  SendTemplateMessageRequestBodySchema,
  SendMessageResponseSchema,
  SendTextMessageBodySchema,
  SendTextMessageRequestBodySchema,
  SendReactionMessageBodySchema,
  SendReactionMessageRequestBodySchema,
  SendImageMessageBodySchema,
  SendImageMessageRequestBodySchema,
} from "../schemas/messages";

const log = debug("trigger:integrations:whatsapp");

type SendTemplateMessageRequestBody = z.infer<
  typeof SendTemplateMessageRequestBodySchema
>;

type SendTextMessageRequestBody = z.infer<
  typeof SendTextMessageRequestBodySchema
>;

type SendReactionMessageRequestBody = z.infer<
  typeof SendReactionMessageRequestBodySchema
>;

type SendImageMessageRequestBody = z.infer<
  typeof SendImageMessageRequestBodySchema
>;

export class WhatsAppRequestIntegration implements RequestIntegration {
  #sendTemplateMessageEndpoint = new HttpEndpoint<
    typeof SendMessageResponseSchema,
    typeof SendTemplateMessageRequestBodySchema
  >({
    response: SendMessageResponseSchema,
    method: "POST",
    path: "/messages",
  });

  #sendTextMessageEndpoint = new HttpEndpoint<
    typeof SendMessageResponseSchema,
    typeof SendTextMessageRequestBodySchema
  >({
    response: SendMessageResponseSchema,
    method: "POST",
    path: "/messages",
  });

  #sendReactionMessageEndpoint = new HttpEndpoint<
    typeof SendMessageResponseSchema,
    typeof SendReactionMessageRequestBodySchema
  >({
    response: SendMessageResponseSchema,
    method: "POST",
    path: "/messages",
  });

  #sendImageMessageEndpoint = new HttpEndpoint<
    typeof SendMessageResponseSchema,
    typeof SendImageMessageRequestBodySchema
  >({
    response: SendMessageResponseSchema,
    method: "POST",
    path: "/messages",
  });

  constructor(
    private readonly baseUrl: string = "https://graph.facebook.com/v15.0"
  ) {}

  perform(options: PerformRequestOptions): Promise<PerformedRequestResponse> {
    switch (options.endpoint) {
      case "message.sendTemplate": {
        return this.#sendTemplateMessage(
          options.accessInfo,
          options.params,
          options.cache,
          options.metadata
        );
      }
      case "message.sendText": {
        return this.#sendTextMessage(
          options.accessInfo,
          options.params,
          options.cache,
          options.metadata
        );
      }
      case "message.sendReaction": {
        return this.#sendReactionMessage(
          options.accessInfo,
          options.params,
          options.cache,
          options.metadata
        );
      }
      case "message.sendImage": {
        return this.#sendImageMessage(
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
      case "message.sendTemplate": {
        const parsedParams = SendTemplateMessageBodySchema.parse(params);
        return {
          title: `Send template (${parsedParams.template}) to ${parsedParams.to}`,
          properties: [],
        };
      }
      case "message.sendText": {
        const parsedParams = SendTextMessageBodySchema.parse(params);
        return {
          title: `Send text to ${parsedParams.to}`,
          properties: [],
        };
      }
      case "message.sendReaction": {
        const parsedParams = SendReactionMessageBodySchema.parse(params);
        return {
          title: `Send ${parsedParams.emoji} reaction to ${parsedParams.to}`,
          properties: [],
        };
      }
      case "message.sendImage": {
        const parsedParams = SendImageMessageBodySchema.parse(params);
        return {
          title: `Send image (${parsedParams.url}) to ${parsedParams.to}`,
          properties: [],
        };
      }
      default: {
        throw new Error(`Unknown endpoint: ${endpoint}`);
      }
    }
  }

  async #sendTemplateMessage(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = SendTemplateMessageBodySchema.parse(params);

    log("message.sendTemplate %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: `${this.baseUrl}/${parsedParams.fromId}`,
    });

    //transform the data from the nice input format into the format that the API expects
    const components: SendTemplateMessageRequestBody["template"]["components"] =
      [];

    if (parsedParams.parameters?.header) {
      components.push({
        type: "header",
        parameters: parsedParams.parameters.header,
      });
    }

    if (parsedParams.parameters?.body) {
      components.push({
        type: "body",
        parameters: parsedParams.parameters.body,
      });
    }

    if (parsedParams.parameters?.buttons) {
      parsedParams.parameters.buttons.forEach((button, index) => {
        components.push({
          type: "button",
          sub_type: button.sub_type,
          index: index,
          parameters: button.parameters,
        });
      });
    }

    const request: SendTemplateMessageRequestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: parsedParams.to,
      type: "template",
      template: {
        name: parsedParams.template,
        language: {
          policy: "deterministic",
          code: parsedParams.languageCode,
        },
        components,
      },
    };

    const response = await service.performRequest(
      this.#sendTemplateMessageEndpoint,
      request
    );

    if (!response.success) {
      log("message.sendTemplate failed %O", response);

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

    const ok = response.statusCode === 200;

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

    log("message.sendTemplate performedRequest %O", performedRequest);

    return performedRequest;
  }

  async #sendTextMessage(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = SendTextMessageBodySchema.parse(params);

    log("message.sendText %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: `${this.baseUrl}/${parsedParams.fromId}`,
    });

    //transform the data from the nice input format into the format that the API expects
    const request: SendTextMessageRequestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: parsedParams.to,
      type: "text",
      text: {
        body: parsedParams.text,
        preview_url: parsedParams.preview_url ?? true,
      },
      context: parsedParams.isReplyTo
        ? { message_id: parsedParams.isReplyTo }
        : undefined,
    };

    const response = await service.performRequest(
      this.#sendTextMessageEndpoint,
      request
    );

    if (!response.success) {
      log("message.sendText failed %O", response);

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

    const ok = response.statusCode === 200;

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

    log("message.sendText performedRequest %O", performedRequest);

    return performedRequest;
  }

  async #sendReactionMessage(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = SendReactionMessageBodySchema.parse(params);

    log("message.sendReaction %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: `${this.baseUrl}/${parsedParams.fromId}`,
    });

    //transform the data from the nice input format into the format that the API expects
    const request: SendReactionMessageRequestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: parsedParams.to,
      type: "reaction",
      reaction: {
        message_id: parsedParams.isReplyTo,
        emoji: parsedParams.emoji,
      },
    };

    const response = await service.performRequest(
      this.#sendReactionMessageEndpoint,
      request
    );

    if (!response.success) {
      log("message.sendReaction failed %O", response);

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

    const ok = response.statusCode === 200;

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

    log("message.sendReaction performedRequest %O", performedRequest);

    return performedRequest;
  }

  async #sendImageMessage(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService,
    metadata?: Record<string, string>
  ): Promise<PerformedRequestResponse> {
    const parsedParams = SendImageMessageBodySchema.parse(params);

    log("message.sendImage %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: `${this.baseUrl}/${parsedParams.fromId}`,
    });

    //transform the data from the nice input format into the format that the API expects
    const request: SendImageMessageRequestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: parsedParams.to,
      type: "image",
      image: {
        link: parsedParams.url,
        caption: parsedParams.caption,
      },
      context: parsedParams.isReplyTo
        ? { message_id: parsedParams.isReplyTo }
        : undefined,
    };

    const response = await service.performRequest(
      this.#sendImageMessageEndpoint,
      request
    );

    if (!response.success) {
      log("message.sendImage failed %O", response);

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

    const ok = response.statusCode === 200;

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

    log("message.sendImage performedRequest %O", performedRequest);

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
}
