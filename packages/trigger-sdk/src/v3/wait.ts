import { SpanStatusCode } from "@opentelemetry/api";
import {
  accessoryAttributes,
  apiClientManager,
  ApiPromise,
  ApiRequestOptions,
  CompleteWaitpointTokenResponseBody,
  CreateWaitpointTokenRequestBody,
  CreateWaitpointTokenResponse,
  CreateWaitpointTokenResponseBody,
  CursorPagePromise,
  flattenAttributes,
  HttpCallbackResult,
  ListWaitpointTokensQueryParams,
  mergeRequestOptions,
  Prettify,
  runtime,
  SemanticInternalAttributes,
  taskContext,
  tryCatch,
  WaitpointListTokenItem,
  WaitpointRetrieveTokenResponse,
  WaitpointTokenStatus,
  WaitpointTokenTypedResult,
} from "@trigger.dev/core/v3";
import { conditionallyImportAndParsePacket } from "@trigger.dev/core/v3/utils/ioSerialization";
import { tracer } from "./tracer.js";

/**
 * This creates a waitpoint token.
 * You can use this to pause a run until you complete the waitpoint (or it times out).
 *
 * @example
 *
 * ```ts
 * const token = await wait.createToken({
 *   idempotencyKey: `approve-document-${documentId}`,
 *   timeout: "24h",
 *   tags: [`document-${documentId}`],
 * });
 *
 * // Later, in a different part of your codebase, you can complete the waitpoint
 * await wait.completeToken(token, {
 *   status: "approved",
 *   comment: "Looks good to me!",
 * });
 * ```
 *
 * @param options - The options for the waitpoint token.
 * @param requestOptions - The request options for the waitpoint token.
 * @returns The waitpoint token.
 */
function createToken(
  options?: CreateWaitpointTokenRequestBody,
  requestOptions?: ApiRequestOptions
): ApiPromise<CreateWaitpointTokenResponse> {
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
        tags: options?.tags,
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

/**
 * Lists waitpoint tokens with optional filtering and pagination.
 * You can iterate over all the items in the result using a for-await-of loop (you don't need to think about pagination).
 *
 * @example
 * Basic usage:
 * ```ts
 * // List all tokens
 * for await (const token of wait.listTokens()) {
 *   console.log("Token ID:", token.id);
 * }
 * ```
 *
 * @example
 * With filters:
 * ```ts
 * // List completed tokens from the last 24 hours with specific tags
 * for await (const token of wait.listTokens({
 *   status: "COMPLETED",
 *   period: "24h",
 *   tags: ["important", "approval"],
 *   limit: 50
 * })) {
 *   console.log("Token ID:", token.id);
 * }
 * ```
 *
 * @param params - Optional query parameters for filtering and pagination
 * @param params.status - Filter by token status
 * @param params.idempotencyKey - Filter by idempotency key
 * @param params.tags - Filter by tags
 * @param params.period - Filter by time period (e.g. "24h", "7d")
 * @param params.from - Filter by start date
 * @param params.to - Filter by end date
 * @param params.limit - Number of items per page
 * @param params.after - Cursor for next page
 * @param params.before - Cursor for previous page
 * @param requestOptions - Additional API request options
 * @returns Waitpoint tokens that can easily be iterated over using a for-await-of loop
 */
function listTokens(
  params?: ListWaitpointTokensQueryParams,
  requestOptions?: ApiRequestOptions
): CursorPagePromise<typeof WaitpointListTokenItem> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "wait.listTokens()",
      icon: "wait-token",
      attributes: {
        ...flattenAttributes(params as Record<string, unknown>),
      },
    },
    requestOptions
  );

  return apiClient.listWaitpointTokens(params, $requestOptions);
}

/**
 * A waitpoint token that has been retrieved.
 *
 * If the status is `WAITING`, this means the waitpoint is still pending.
 * For `COMPLETED` the `output` will be the data you passed in when completing the waitpoint.
 * For `TIMED_OUT` there will be an `error`.
 */
export type WaitpointRetrievedToken<T> = {
  id: string;
  status: WaitpointTokenStatus;
  completedAt?: Date;
  timeoutAt?: Date;
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
  tags: string[];
  createdAt: Date;
  output?: T;
  error?: Error;
};

/**
 * Retrieves a waitpoint token by its ID.
 *
 * @example
 * ```ts
 * const token = await wait.retrieveToken("waitpoint_12345678910");
 * console.log("Token status:", token.status);
 * console.log("Token tags:", token.tags);
 * ```
 *
 * @param token - The token to retrieve.
 * This can be a string token ID or an object with an `id` property.
 * @param requestOptions - Optional API request options.
 * @returns The waitpoint token details, including the output or error if the waitpoint is completed or timed out.
 */
async function retrieveToken<T>(
  token: string | { id: string },
  requestOptions?: ApiRequestOptions
): Promise<WaitpointRetrievedToken<T>> {
  const apiClient = apiClientManager.clientOrThrow();

  const $tokenId = typeof token === "string" ? token : token.id;

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "wait.retrieveToken()",
      icon: "wait-token",
      attributes: {
        id: $tokenId,
        ...accessoryAttributes({
          items: [
            {
              text: $tokenId,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
      onResponseBody: (body: WaitpointRetrieveTokenResponse, span) => {
        span.setAttribute("id", body.id);
        span.setAttribute("status", body.status);
        if (body.completedAt) {
          span.setAttribute("completedAt", body.completedAt.toISOString());
        }
        if (body.timeoutAt) {
          span.setAttribute("timeoutAt", body.timeoutAt.toISOString());
        }
        if (body.idempotencyKey) {
          span.setAttribute("idempotencyKey", body.idempotencyKey);
        }
        if (body.idempotencyKeyExpiresAt) {
          span.setAttribute("idempotencyKeyExpiresAt", body.idempotencyKeyExpiresAt.toISOString());
        }
        span.setAttribute("tags", body.tags);
        span.setAttribute("createdAt", body.createdAt.toISOString());
      },
    },
    requestOptions
  );

  const result = await apiClient.retrieveWaitpointToken($tokenId, $requestOptions);

  const data = result.output
    ? await conditionallyImportAndParsePacket(
        { data: result.output, dataType: result.outputType ?? "application/json" },
        apiClient
      )
    : undefined;

  let error: Error | undefined = undefined;
  let output: T | undefined = undefined;

  if (result.outputIsError) {
    error = new WaitpointTimeoutError(data.message);
  } else {
    output = data as T;
  }

  return {
    id: result.id,
    status: result.status,
    completedAt: result.completedAt,
    timeoutAt: result.timeoutAt,
    idempotencyKey: result.idempotencyKey,
    idempotencyKeyExpiresAt: result.idempotencyKeyExpiresAt,
    tags: result.tags,
    createdAt: result.createdAt,
    output,
    error,
  };
}

/**
 * This completes a waitpoint token.
 * You can use this to complete a waitpoint token that you created earlier.
 *
 * @example
 *
 * ```ts
 * await wait.completeToken(token, {
 *   status: "approved",
 *   comment: "Looks good to me!",
 * });
 * ```
 *
 * @param token - The token to complete.
 * @param data - The data to complete the waitpoint with.
 * @param requestOptions - The request options for the waitpoint token.
 * @returns The waitpoint token.
 */
async function completeToken<T>(
  /**
   * The token to complete.
   * This can be a string token ID or an object with an `id` property.
   */
  token: string | { id: string },
  /**
   * The data to complete the waitpoint with.
   * This will be returned when you wait for the token.
   */
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

const DURATION_WAIT_CHARGE_THRESHOLD_MS = 5000;

function printWaitBelowThreshold() {
  console.warn(
    `Waits of ${DURATION_WAIT_CHARGE_THRESHOLD_MS / 1000}s or less count towards compute usage.`
  );
}

class ManualWaitpointPromise<TOutput> extends Promise<WaitpointTokenTypedResult<TOutput>> {
  constructor(
    executor: (
      resolve: (
        value: WaitpointTokenTypedResult<TOutput> | PromiseLike<WaitpointTokenTypedResult<TOutput>>
      ) => void,
      reject: (reason?: any) => void
    ) => void
  ) {
    super(executor);
  }

  unwrap(): Promise<TOutput> {
    return this.then((result) => {
      if (result.ok) {
        return result.output;
      } else {
        throw new WaitpointTimeoutError(result.error.message);
      }
    });
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

    if (durationInMs <= DURATION_WAIT_CHARGE_THRESHOLD_MS) {
      return tracer.startActiveSpan(
        `wait.for()`,
        async (span) => {
          if (durationInMs <= 0) {
            return;
          }

          printWaitBelowThreshold();

          await new Promise((resolve) => setTimeout(resolve, durationInMs));
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
    }

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

    // Calculate duration in ms
    const durationInMs = options.date.getTime() - Date.now();

    if (durationInMs <= DURATION_WAIT_CHARGE_THRESHOLD_MS) {
      return tracer.startActiveSpan(
        `wait.for()`,
        async (span) => {
          if (durationInMs === 0) {
            return;
          }

          if (durationInMs < 0) {
            if (options.throwIfInThePast) {
              throw new Error("Date is in the past");
            }

            return;
          }

          printWaitBelowThreshold();

          await new Promise((resolve) => setTimeout(resolve, durationInMs));
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
  listTokens,
  completeToken,
  retrieveToken,
  /**
   * This waits for a waitpoint token to be completed.
   * It can only be used inside a task.run() block.
   *
   * @example
   *
   * ```ts
   * const result = await wait.forToken<typeof ApprovalData>(token);
   * if (!result.ok) {
   *   // The waitpoint timed out
   *   throw result.error;
   * }
   *
   * // This will be the type ApprovalData
   * const approval = result.output;
   * ```
   *
   * @param token - The token to wait for.
   * @param options - The options for the waitpoint token.
   * @returns The waitpoint token.
   */
  forToken: <T>(
    /**
     * The token to wait for.
     * This can be a string token ID or an object with an `id` property.
     */
    token: string | { id: string },
    /**
     * The options for the waitpoint token.
     */
    options?: {
      /**
       * If set to true, this will cause the waitpoint to release the current run from the queue's concurrency.
       *
       * This is useful if you want to allow other runs to execute while waiting
       *
       * @default false
       */
      releaseConcurrency?: boolean;
    }
  ): ManualWaitpointPromise<T> => {
    return new ManualWaitpointPromise<T>(async (resolve, reject) => {
      try {
        const ctx = taskContext.ctx;

        if (!ctx) {
          throw new Error("wait.forToken can only be used from inside a task.run()");
        }

        const apiClient = apiClientManager.clientOrThrow();

        const tokenId = typeof token === "string" ? token : token.id;

        const result = await tracer.startActiveSpan(
          `wait.forToken()`,
          async (span) => {
            const response = await apiClient.waitForWaitpointToken({
              runFriendlyId: ctx.run.id,
              waitpointFriendlyId: tokenId,
              releaseConcurrency: options?.releaseConcurrency,
            });

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

        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  },
  /**
   * This allows you to start some work on another API (or one of your own services) 
   * and continue the run when a callback URL we give you is hit with the result.
   * 
   * You should send the callback URL to the other service, and then that service will 
   * make a request to the callback URL with the result.
   * 
   * @example
   * 
   * ```ts
   * //wait for the prediction to complete
    const prediction = await wait.forHttpCallback<Prediction>(
      async (url) => {
        //pass the provided URL to Replicate's webhook
        await replicate.predictions.create({
          version:
            "19deaef633fd44776c82edf39fd60e95a7250b8ececf11a725229dc75a81f9ca",
          input: payload,
          // pass the provided URL to Replicate's webhook, so they can "callback"
          webhook: url,
          webhook_events_filter: ["completed"],
        });
      },
      {
        timeout: "2m",
      }
    );

    //the value of prediction is the body of the webook that Replicate sent
    const result = prediction.output;
   * ```
   * 
   * @param callback 
   * @param options 
   * @param requestOptions 
   * @returns 
   */
  forHttpCallback<TResult>(
    callback: (url: string) => Promise<void>,
    options?: CreateWaitpointTokenRequestBody & {
      /**
       * If set to true, this will cause the waitpoint to release the current run from the queue's concurrency.
       *
       * This is useful if you want to allow other runs to execute while waiting
       *
       * @default false
       */
      releaseConcurrency?: boolean;
    },
    requestOptions?: ApiRequestOptions
  ): ManualWaitpointPromise<TResult> {
    return new ManualWaitpointPromise<TResult>(async (resolve, reject) => {
      try {
        const ctx = taskContext.ctx;

        if (!ctx) {
          throw new Error("wait.forHttpCallback can only be used from inside a task.run()");
        }

        const apiClient = apiClientManager.clientOrThrow();

        const waitpoint = await apiClient.createWaitpointHttpCallback(
          options ?? {},
          requestOptions
        );

        const result = await tracer.startActiveSpan(
          `wait.forHttpCallback()`,
          async (span) => {
            const [error] = await tryCatch(callback(waitpoint.url));

            if (error) {
              throw new Error(`You threw an error in your callback: ${error.message}`, {
                cause: error,
              });
            }

            const response = await apiClient.waitForWaitpointToken({
              runFriendlyId: ctx.run.id,
              waitpointFriendlyId: waitpoint.id,
              releaseConcurrency: options?.releaseConcurrency,
            });

            if (!response.success) {
              throw new Error(`Failed to wait for wait for HTTP callback ${waitpoint.id}`);
            }

            const result = await runtime.waitUntil(waitpoint.id);

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
              };
            } else {
              const error = new WaitpointTimeoutError(data.message);

              span.recordException(error);
              span.setStatus({
                code: SpanStatusCode.ERROR,
              });

              return {
                ok: result.ok,
                error,
              };
            }
          },
          {
            attributes: {
              [SemanticInternalAttributes.STYLE_ICON]: "wait",
              [SemanticInternalAttributes.ENTITY_TYPE]: "waitpoint",
              [SemanticInternalAttributes.ENTITY_ID]: waitpoint.id,
              ...accessoryAttributes({
                items: [
                  {
                    text: waitpoint.id,
                    variant: "normal",
                  },
                ],
                style: "codepath",
              }),
              id: waitpoint.id,
              isCached: waitpoint.isCached,
              idempotencyKey: options?.idempotencyKey,
              idempotencyKeyTTL: options?.idempotencyKeyTTL,
              timeout: options?.timeout
                ? typeof options.timeout === "string"
                  ? options.timeout
                  : options.timeout.toISOString()
                : undefined,
              tags: options?.tags,
              url: waitpoint.url,
            },
          }
        );

        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
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
