import {
  HttpEndpoint,
  HttpService,
  getAccessToken,
} from "@trigger.dev/integration-sdk";
import type {
  DisplayProperties,
  CacheService,
  PerformedRequestResponse,
  PerformRequestOptions,
  RequestIntegration,
  AccessInfo,
} from "@trigger.dev/integration-sdk";
import debug from "debug";
import { SendEmailResponseSchema, SendEmailBodySchema } from "../schemas";

const log = debug("trigger:integrations:resend");

export class ResendRequestIntegration implements RequestIntegration {
  #sendEmailEndpoint = new HttpEndpoint<
    typeof SendEmailResponseSchema,
    typeof SendEmailBodySchema
  >({
    response: SendEmailResponseSchema,
    method: "POST",
    path: "/email",
  });

  constructor(private readonly baseUrl: string = "https://api.resend.com") {}

  perform(options: PerformRequestOptions): Promise<PerformedRequestResponse> {
    switch (options.endpoint) {
      case "email.send": {
        return this.#sendEmail(
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
      case "email.send": {
        const parsed = SendEmailBodySchema.parse(params);
        return {
          title: `Send email to ${
            typeof parsed.to === "string" ? parsed.to : parsed.to.join(", ")
          }`,
          properties: [],
        };
      }
      default: {
        throw new Error(`Unknown endpoint: ${endpoint}`);
      }
    }
  }

  async #sendEmail(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService
  ): Promise<PerformedRequestResponse> {
    const parsedParams = SendEmailBodySchema.parse(params);

    log("email.send %O", parsedParams);

    const accessToken = getAccessToken(accessInfo);

    const service = new HttpService({
      accessToken,
      baseUrl: this.baseUrl,
    });

    const response = await service.performRequest(this.#sendEmailEndpoint, {
      ...parsedParams,
    });

    if (!response.success) {
      log("email.send failed %O", response);

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

    if (response.statusCode !== 200) {
      log("email.send failed %O", response);

      return {
        ok: false,
        isRetryable: this.#isRetryable(response.statusCode),
        response: {
          output: response.data,
          context: {
            statusCode: response.statusCode,
            headers: response.headers,
          },
        },
      };
    }

    const performedRequest = {
      ok: response.success,
      isRetryable: this.#isRetryable(response.statusCode),
      response: {
        output: response.data,
        context: {
          statusCode: response.statusCode,
          headers: response.headers,
        },
      },
    };

    log("email.send performedRequest %O", performedRequest);

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
