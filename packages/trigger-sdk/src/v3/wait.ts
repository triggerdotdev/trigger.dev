import {
  SemanticInternalAttributes,
  accessoryAttributes,
  runtime,
  apiClientManager,
  ApiPromise,
  ApiRequestOptions,
  conditionallyExportPacket,
  CreateWaitpointTokenRequestBody,
  CreateWaitpointTokenResponseBody,
  mergeRequestOptions,
  stringifyIO,
  CompleteWaitpointTokenResponseBody,
  WaitForWaitpointTokenRequestBody,
  WaitpointTokenTypedResult,
  Prettify,
  taskContext,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";
import { conditionallyImportPacket } from "../../../core/dist/commonjs/v3/index.js";
import { conditionallyImportAndParsePacket } from "@trigger.dev/core/v3/utils/ioSerialization";

function createToken(
  options?: CreateWaitpointTokenRequestBody,
  requestOptions?: ApiRequestOptions
): ApiPromise<CreateWaitpointTokenResponseBody> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "wait.createToken()",
      icon: "wait-token",
      attributes: {
        idempotencyKey: options?.idempotencyKey,
        idempotencyKeyTTL: options?.idempotencyKeyTTL,
        timeout: options?.timeout
          ? typeof options.timeout === "string"
            ? options.timeout
            : options.timeout.toISOString()
          : undefined,
      },
      onResponseBody: (body: CreateWaitpointTokenResponseBody, span) => {
        span.setAttribute("id", body.id);
        span.setAttribute("isCached", body.isCached);
      },
    },
    requestOptions
  );

  return apiClient.createWaitpointToken(options ?? {}, $requestOptions);
}

async function completeToken<T>(
  token: string | { id: string },
  data: T,
  requestOptions?: ApiRequestOptions
) {
  const apiClient = apiClientManager.clientOrThrow();

  const tokenId = typeof token === "string" ? token : token.id;

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "wait.completeToken()",
      icon: "wait-token",
      attributes: {
        id: tokenId,
      },
      onResponseBody: (body: CompleteWaitpointTokenResponseBody, span) => {
        span.setAttribute("success", body.success);
      },
    },
    requestOptions
  );

  return apiClient.completeResumeToken(tokenId, { data }, $requestOptions);
}

export type WaitOptions =
  | {
      seconds: number;
    }
  | {
      minutes: number;
    }
  | {
      hours: number;
    }
  | {
      days: number;
    }
  | {
      weeks: number;
    }
  | {
      months: number;
    }
  | {
      years: number;
    };

export const wait = {
  for: async (options: WaitOptions) => {
    return tracer.startActiveSpan(
      `wait.for()`,
      async (span) => {
        const start = Date.now();
        const durationInMs = calculateDurationInMs(options);

        await runtime.waitForDuration(durationInMs);
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "wait",
          ...accessoryAttributes({
            items: [
              {
                text: nameForWaitOptions(options),
                variant: "normal",
              },
            ],
            style: "codepath",
          }),
        },
      }
    );
  },
  until: async (options: { date: Date; throwIfInThePast?: boolean }) => {
    return tracer.startActiveSpan(
      `wait.until()`,
      async (span) => {
        const start = Date.now();

        if (options.throwIfInThePast && options.date < new Date()) {
          throw new Error("Date is in the past");
        }

        const durationInMs = options.date.getTime() - start;

        await runtime.waitForDuration(durationInMs);
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "wait",
          ...accessoryAttributes({
            items: [
              {
                text: options.date.toISOString(),
                variant: "normal",
              },
            ],
            style: "codepath",
          }),
        },
      }
    );
  },
  createToken,
  completeToken,
  forToken: async <T>(
    token: string | { id: string },
    options?: WaitForWaitpointTokenRequestBody
  ): Promise<Prettify<WaitpointTokenTypedResult<T>>> => {
    const ctx = taskContext.ctx;

    if (!ctx) {
      throw new Error("wait.forToken can only be used from inside a task.run()");
    }

    const apiClient = apiClientManager.clientOrThrow();

    const tokenId = typeof token === "string" ? token : token.id;

    return tracer.startActiveSpan(
      `wait.forToken()`,
      async (span) => {
        const response = await apiClient.waitForWaitpointToken(ctx.run.id, tokenId, options);

        if (!response.success) {
          throw new Error(`Failed to wait for wait token ${tokenId}`);
        }

        const result = await runtime.waitForToken(tokenId, options);

        const data = result.output
          ? await conditionallyImportAndParsePacket(
              { data: result.output, dataType: result.outputType ?? "application/json" },
              apiClient
            )
          : undefined;

        if (result.ok) {
          return {
            ok: result.ok,
            output: data,
          } as WaitpointTokenTypedResult<T>;
        } else {
          return {
            ok: result.ok,
            error: data,
          } as WaitpointTokenTypedResult<T>;
        }
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "wait-token",
          id: tokenId,
          ...accessoryAttributes({
            items: [
              {
                text: tokenId,
                variant: "normal",
              },
            ],
            style: "codepath",
          }),
        },
      }
    );
  },
};

function nameForWaitOptions(options: WaitOptions): string {
  if ("seconds" in options) {
    return options.seconds === 1 ? `1 second` : `${options.seconds} seconds`;
  }

  if ("minutes" in options) {
    return options.minutes === 1 ? `1 minute` : `${options.minutes} minutes`;
  }

  if ("hours" in options) {
    return options.hours === 1 ? `1 hour` : `${options.hours} hours`;
  }

  if ("days" in options) {
    return options.days === 1 ? `1 day` : `${options.days} days`;
  }

  if ("weeks" in options) {
    return options.weeks === 1 ? `1 week` : `${options.weeks} weeks`;
  }

  if ("months" in options) {
    return options.months === 1 ? `1 month` : `${options.months} months`;
  }

  if ("years" in options) {
    return options.years === 1 ? `1 year` : `${options.years} years`;
  }

  return "NaN";
}

function calculateDurationInMs(options: WaitOptions): number {
  if ("seconds" in options) {
    return options.seconds * 1000;
  }

  if ("minutes" in options) {
    return options.minutes * 1000 * 60;
  }

  if ("hours" in options) {
    return options.hours * 1000 * 60 * 60;
  }

  if ("days" in options) {
    return options.days * 1000 * 60 * 60 * 24;
  }

  if ("weeks" in options) {
    return options.weeks * 1000 * 60 * 60 * 24 * 7;
  }

  if ("months" in options) {
    return options.months * 1000 * 60 * 60 * 24 * 30;
  }

  if ("years" in options) {
    return options.years * 1000 * 60 * 60 * 24 * 365;
  }

  throw new Error("Invalid options");
}

type RequestOptions = {
  to: (url: string) => Promise<void>;
  timeout: WaitOptions;
};
