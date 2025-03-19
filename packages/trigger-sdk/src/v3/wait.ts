import {
  SemanticInternalAttributes,
  accessoryAttributes,
  runtime,
  apiClientManager,
  ApiPromise,
  ApiRequestOptions,
  CreateWaitpointTokenRequestBody,
  CreateWaitpointTokenResponseBody,
  mergeRequestOptions,
  CompleteWaitpointTokenResponseBody,
  WaitpointTokenTypedResult,
  Prettify,
  taskContext,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";
import { conditionallyImportAndParsePacket } from "@trigger.dev/core/v3/utils/ioSerialization";
import { SpanStatusCode } from "@opentelemetry/api";

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

  return apiClient.completeWaitpointToken(tokenId, { data }, $requestOptions);
}

export type CommonWaitOptions = {
  /**
   * An optional idempotency key for the waitpoint.
   * If you use the same key twice (and the key hasn't expired), you will get the original waitpoint back.
   *
   * Note: This waitpoint may already be complete, in which case when you wait for it, it will immediately continue.
   */
  idempotencyKey?: string;
  /**
   * When set, this means the passed in idempotency key will expire after this time.
   * This means after that time if you pass the same idempotency key again, you will get a new waitpoint.
   */
  idempotencyKeyTTL?: string;

  /**
   * If set to true, this will cause the waitpoint to release the current run from the queue's concurrency.
   *
   * This is useful if you want to allow other runs to execute while this waitpoint is pending
   *
   * Note: It's possible that this run will not be able to resume when the waitpoint is complete if this is set to true.
   * It will go back in the queue and will resume once concurrency becomes available.
   *
   *
   * @default false
   */
  releaseConcurrency?: boolean;
};

export type WaitForOptions = WaitPeriod & CommonWaitOptions;

type WaitPeriod =
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

export class WaitpointTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaitpointTimeoutError";
  }
}

export const wait = {
  for: async (options: WaitForOptions) => {
    const ctx = taskContext.ctx;
    if (!ctx) {
      throw new Error("wait.forToken can only be used from inside a task.run()");
    }

    const apiClient = apiClientManager.clientOrThrow();

    const start = Date.now();
    const durationInMs = calculateDurationInMs(options);
    const date = new Date(start + durationInMs);
    const result = await apiClient.waitForDuration(ctx.run.id, {
      date: date,
      idempotencyKey: options.idempotencyKey,
      idempotencyKeyTTL: options.idempotencyKeyTTL,
      releaseConcurrency: options.releaseConcurrency,
    });

    return tracer.startActiveSpan(
      `wait.for()`,
      async (span) => {
        await runtime.waitUntil(result.waitpoint.id, date);
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "wait",
          [SemanticInternalAttributes.ENTITY_TYPE]: "waitpoint",
          [SemanticInternalAttributes.ENTITY_ID]: result.waitpoint.id,
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
  until: async (options: { date: Date; throwIfInThePast?: boolean } & CommonWaitOptions) => {
    const ctx = taskContext.ctx;
    if (!ctx) {
      throw new Error("wait.forToken can only be used from inside a task.run()");
    }

    const apiClient = apiClientManager.clientOrThrow();

    const result = await apiClient.waitForDuration(ctx.run.id, {
      date: options.date,
      idempotencyKey: options.idempotencyKey,
      idempotencyKeyTTL: options.idempotencyKeyTTL,
      releaseConcurrency: options.releaseConcurrency,
    });

    return tracer.startActiveSpan(
      `wait.until()`,
      async (span) => {
        if (options.throwIfInThePast && options.date < new Date()) {
          throw new Error("Date is in the past");
        }

        await runtime.waitUntil(result.waitpoint.id, options.date);
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "wait",
          [SemanticInternalAttributes.ENTITY_TYPE]: "waitpoint",
          [SemanticInternalAttributes.ENTITY_ID]: result.waitpoint.id,
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
    token: string | { id: string }
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
        const response = await apiClient.waitForWaitpointToken(ctx.run.id, tokenId);

        if (!response.success) {
          throw new Error(`Failed to wait for wait token ${tokenId}`);
        }

        const result = await runtime.waitUntil(tokenId);

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
          const error = new WaitpointTimeoutError(data.message);

          span.recordException(error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
          });

          return {
            ok: result.ok,
            error,
          } as WaitpointTokenTypedResult<T>;
        }
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "wait",
          [SemanticInternalAttributes.ENTITY_TYPE]: "waitpoint",
          [SemanticInternalAttributes.ENTITY_ID]: tokenId,
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

function nameForWaitOptions(options: WaitForOptions): string {
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

function calculateDurationInMs(options: WaitForOptions): number {
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
  timeout: WaitForOptions;
};
