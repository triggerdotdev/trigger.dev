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
  SendTemplateMessageResponseSchema,
} from "../schemas/messages";

const log = debug("trigger:integrations:slack");

type SendTemplateMessageRequestBody = z.infer<
  typeof SendTemplateMessageRequestBodySchema
>;

export class WhatsAppRequestIntegration implements RequestIntegration {
  #sendTemplateMessageEndpoint = new HttpEndpoint<
    typeof SendTemplateMessageResponseSchema,
    typeof SendTemplateMessageRequestBodySchema
  >({
    response: SendTemplateMessageResponseSchema,
    method: "POST",
    path: "/messages",
  });

  constructor(private readonly baseUrl: string = "https://slack.com/api") {}

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
      default: {
        throw new Error(`Unknown endpoint: ${options.endpoint}`);
      }
    }
  }

  displayProperties(endpoint: string, params: any): DisplayProperties {
    switch (endpoint) {
      case "message.sendTemplate": {
        return {
          title: `Send template message`,
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
