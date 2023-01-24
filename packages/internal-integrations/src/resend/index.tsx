import { HttpEndpoint, HttpService } from "../services";
import {
  DisplayProperties,
  CacheService,
  PerformedRequestResponse,
  PerformRequestOptions,
  RequestIntegration,
  AccessInfo,
} from "../types";
import { resend } from "@trigger.dev/providers";
import debug from "debug";
import { getAccessToken } from "../accessInfo";
import { SendEmailBodySchema } from "@trigger.dev/providers/providers/resend/schemas";
import React from "react";

const log = debug("trigger:integrations:resend");

class ResendRequestIntegration implements RequestIntegration {
  #sendEmailEndpoint = new HttpEndpoint<
    typeof resend.schemas.SendEmailResponseSchema,
    typeof SendEmailBodySchema
  >({
    response: resend.schemas.SendEmailResponseSchema,
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
        const parsed = resend.schemas.SendEmailBodySchema.parse(params);
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

  renderComponent(input: any, output: any): React.ReactNode {
    const parsedInput = resend.schemas.SendEmailBodySchema.parse(input);
    return (
      <div className="bg-white rounded-md">
        <div className="flex px-2 h-8 items-center bg-slate-100 rounded-t-md">
          <div className="flex h-8 gap-2 items-center bg-slate-100 rounded-t-md">
            <div className="rounded-full bg-rose-500 w-3 h-3"></div>
            <div className="rounded-full bg-orange-500 w-3 h-3"></div>
            <div className="rounded-full bg-emerald-500 w-3 h-3"></div>
          </div>
        </div>
        <div className="px-4 py-2 border-b border-slate-300">
          <h2 className="text-lg text-slate-600 font-bold">
            {parsedInput.from}
          </h2>
          <h2 className="text-slate-600">{parsedInput.subject}</h2>
          <div className="flex gap-2">
            <EmailInfo label="to" value={parsedInput.to} />
            <EmailInfo label="cc" value={parsedInput.cc} />
            <EmailInfo label="bcc" value={parsedInput.bcc} />
          </div>
          <div className="flex gap-2">
            <EmailInfo label="reply to" value={parsedInput.reply_to} />
          </div>
        </div>
        <div className="px-4">
          <div
            dangerouslySetInnerHTML={{
              __html: parsedInput.text ?? parsedInput.html ?? "",
            }}
          ></div>
        </div>
      </div>
    );
  }

  async #sendEmail(
    accessInfo: AccessInfo,
    params: any,
    cache?: CacheService
  ): Promise<PerformedRequestResponse> {
    const parsedParams = resend.schemas.SendEmailBodySchema.parse(params);

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

export const requests = new ResendRequestIntegration();

function EmailInfo({
  label,
  value,
}: {
  label: string;
  value?: string | string[];
}) {
  if (!value) {
    return null;
  }

  return (
    <div className="text-slate-500 text-sm flex items-baseline gap-2">
      <h3 className="text-slate-400">{label}:</h3>
      {typeof value === "string" ? value : value.join(", ")}
    </div>
  );
}
