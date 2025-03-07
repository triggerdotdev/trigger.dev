import { Attributes, Span, SpanStatusCode, context, trace } from "@opentelemetry/api";
import {
  SEMATTRS_HTTP_HOST,
  SEMATTRS_HTTP_METHOD,
  SEMATTRS_HTTP_RESPONSE_CONTENT_LENGTH,
  SEMATTRS_HTTP_SCHEME,
  SEMATTRS_HTTP_STATUS_CODE,
  SEMATTRS_HTTP_URL,
} from "@opentelemetry/semantic-conventions";
import {
  FetchRetryByStatusOptions,
  FetchRetryOptions,
  FetchRetryStrategy,
  RetryOptions,
  SemanticInternalAttributes,
  accessoryAttributes,
  calculateNextRetryDelay,
  calculateResetAt,
  defaultFetchRetryOptions,
  defaultRetryOptions,
  eventFilterMatches,
  flattenAttributes,
  runtime,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";
import { wait } from "./wait.js";

export type { RetryOptions };

function onThrow<T>(
  fn: (options: { attempt: number; maxAttempts: number }) => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const opts = {
    ...defaultRetryOptions,
    ...options,
  };

  return tracer.startActiveSpan(
    `retry.onThrow()`,
    async (span) => {
      let attempt = 1;

      while (attempt <= opts.maxAttempts) {
        const innerSpan = tracer.startSpan("retry.fn()", {
          attributes: {
            [SemanticInternalAttributes.STYLE_ICON]: "function",
            ...accessoryAttributes({
              items: [
                {
                  text: `${attempt}/${opts.maxAttempts}`,
                  variant: "normal",
                },
              ],
              style: "codepath",
            }),
          },
        });

        const contextWithSpanSet = trace.setSpan(context.active(), innerSpan);

        try {
          const result = await context.with(contextWithSpanSet, async () => {
            return fn({ attempt, maxAttempts: opts.maxAttempts });
          });

          innerSpan.end();

          return result;
        } catch (e) {
          if (e instanceof Error || typeof e === "string") {
            innerSpan.recordException(e);
          } else {
            innerSpan.recordException(String(e));
          }

          innerSpan.setStatus({ code: SpanStatusCode.ERROR });

          if (e instanceof Error && e.name === "AbortTaskRunError") {
            innerSpan.end();

            throw e;
          }

          const nextRetryDelay = calculateNextRetryDelay(opts, attempt);

          if (!nextRetryDelay) {
            innerSpan.end();

            throw e;
          }

          innerSpan.setAttribute(
            SemanticInternalAttributes.RETRY_AT,
            new Date(Date.now() + nextRetryDelay).toISOString()
          );
          innerSpan.setAttribute(SemanticInternalAttributes.RETRY_COUNT, attempt);
          innerSpan.setAttribute(SemanticInternalAttributes.RETRY_DELAY, `${nextRetryDelay}ms`);
          innerSpan.end();

          await wait.until({ date: new Date(Date.now() + nextRetryDelay) });
        } finally {
          attempt++;
        }
      }

      throw new Error("Max attempts reached");
    },
    {
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "arrow-capsule",
      },
    }
  );
}

export interface RetryFetchRequestInit extends RequestInit {
  retry?: FetchRetryOptions;
  timeoutInMs?: number;
}

const normalizeUrlFromInput = (input: RequestInfo | URL | string): URL => {
  if (typeof input === "string") {
    return new URL(input);
  }

  if (input instanceof URL) {
    return input;
  }

  return new URL(input.url);
};

const normalizeHttpMethod = (input: RequestInfo | URL | string, init?: RequestInit): string => {
  if (typeof input === "string" || input instanceof URL) {
    return (init?.method || "GET").toUpperCase();
  }

  return (input.method ?? init?.method ?? "GET").toUpperCase();
};

class FetchErrorWithSpan extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly span: Span
  ) {
    super("Fetch error");
  }
}

const MAX_ATTEMPTS = 10;

async function retryFetch(
  input: RequestInfo | URL,
  init?: RetryFetchRequestInit | undefined
): Promise<Response> {
  return tracer.startActiveSpan(
    "retry.fetch()",
    async (span) => {
      let attempt = 1;

      while (true) {
        try {
          const abortController = new AbortController();

          const timeoutId = init?.timeoutInMs
            ? setTimeout(
                () => {
                  abortController.abort();
                },
                init?.timeoutInMs
              )
            : undefined;

          init?.signal?.addEventListener("abort", () => {
            abortController.abort();
          });

          const [response, span] = await doFetchRequest(
            input,
            { ...(init ?? {}), signal: abortController.signal },
            attempt
          );

          if (timeoutId) {
            clearTimeout(timeoutId);
          }

          if (response.ok) {
            span.setAttributes(createFetchResponseAttributes(response));

            span.end();

            return response;
          }

          const nextRetry = await calculateRetryDelayForResponse(
            resolveDefaults(init?.retry, "byStatus", defaultFetchRetryOptions.byStatus),
            response,
            attempt
          );

          if (!nextRetry) {
            span.setAttributes(createFetchResponseAttributes(response));

            span.end();

            return response;
          }

          if (attempt >= MAX_ATTEMPTS) {
            span.setAttributes(createFetchResponseAttributes(response));

            span.end();

            return response;
          }

          if (nextRetry.type === "delay") {
            const continueDate = new Date(Date.now() + nextRetry.value);
            span.setAttribute(SemanticInternalAttributes.RETRY_AT, continueDate.toISOString());
            span.setAttribute(SemanticInternalAttributes.RETRY_COUNT, attempt);
            span.setAttribute(SemanticInternalAttributes.RETRY_DELAY, `${nextRetry.value}ms`);

            span.end();

            await wait.until({ date: continueDate });
          } else {
            const now = Date.now();
            const nextRetryDate = new Date(nextRetry.value);
            const isInFuture = nextRetryDate.getTime() > now;

            span.setAttribute(
              SemanticInternalAttributes.RETRY_AT,
              new Date(nextRetry.value).toISOString()
            );
            span.setAttribute(SemanticInternalAttributes.RETRY_COUNT, attempt);

            if (isInFuture) {
              span.setAttribute(
                SemanticInternalAttributes.RETRY_DELAY,
                `${nextRetry.value - now}ms`
              );
            }

            span.end();

            await wait.until({ date: new Date(nextRetry.value) });
          }
        } catch (e) {
          if (e instanceof FetchErrorWithSpan && e.originalError instanceof Error) {
            if (e.originalError.name === "AbortError") {
              const nextRetryDelay = calculateNextRetryDelay(
                resolveDefaults(init?.retry, "timeout", defaultFetchRetryOptions.timeout),
                attempt
              );

              if (!nextRetryDelay) {
                e.span.end();
                throw e;
              }

              if (attempt >= MAX_ATTEMPTS) {
                e.span.end();
                throw e;
              }

              const continueDate = new Date(Date.now() + nextRetryDelay);
              e.span.setAttribute(SemanticInternalAttributes.RETRY_AT, continueDate.toISOString());
              e.span.setAttribute(SemanticInternalAttributes.RETRY_COUNT, attempt);
              e.span.setAttribute(SemanticInternalAttributes.RETRY_DELAY, `${nextRetryDelay}ms`);

              e.span.end();

              await wait.until({ date: continueDate });

              continue; // Move to the next attempt
            } else if (
              e.originalError.name === "TypeError" &&
              "cause" in e.originalError &&
              e.originalError.cause instanceof Error
            ) {
              const nextRetryDelay = calculateNextRetryDelay(
                resolveDefaults(
                  init?.retry,
                  "connectionError",
                  defaultFetchRetryOptions.connectionError
                ),
                attempt
              );

              if (!nextRetryDelay) {
                e.span.end();
                throw e;
              }

              if (attempt >= MAX_ATTEMPTS) {
                e.span.end();
                throw e;
              }

              e.span.setAttribute(
                SemanticInternalAttributes.RETRY_AT,
                new Date(Date.now() + nextRetryDelay).toISOString()
              );
              e.span.setAttribute(SemanticInternalAttributes.RETRY_COUNT, attempt);
              e.span.setAttribute(SemanticInternalAttributes.RETRY_DELAY, `${nextRetryDelay}ms`);

              e.span.end();

              await wait.until({ date: new Date(Date.now() + nextRetryDelay) });

              continue; // Move to the next attempt
            }
          }

          if (e instanceof FetchErrorWithSpan) {
            e.span.end();
          }

          throw e;
        } finally {
          attempt++;
        }
      }
    },
    {
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "arrow-capsule",
        ...createFetchAttributes(input, init),
        ...createFetchRetryOptionsAttributes(init?.retry),
      },
    }
  );
}

const doFetchRequest = async (
  input: RequestInfo | URL | string,
  init?: RequestInit,
  attemptCount: number = 0
): Promise<[Response, Span]> => {
  const httpMethod = normalizeHttpMethod(input, init);

  const span = tracer.startSpan(`HTTP ${httpMethod}`, {
    attributes: {
      [SemanticInternalAttributes.STYLE_ICON]: "world",
      ...(attemptCount > 1 ? { ["http.request.resend_count"]: attemptCount - 1 } : {}),
      ...createFetchAttributes(input, init),
    },
  });

  try {
    const response = await fetch(input, {
      ...init,
      headers: {
        ...init?.headers,
        "x-retry-count": attemptCount.toString(),
      },
    });

    span.setAttributes(createFetchResponseAttributes(response));

    if (!response.ok) {
      span.recordException(`${response.status}: ${response.statusText}`);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `${response.status}: ${response.statusText}`,
      });
    }

    return [response, span];
  } catch (e) {
    if (typeof e === "string" || e instanceof Error) {
      span.recordException(e);
    }

    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute(SEMATTRS_HTTP_STATUS_CODE, 0);
    span.setAttribute("http.status_text", "This operation was aborted.");

    throw new FetchErrorWithSpan(e, span);
  }
};

const calculateRetryDelayForResponse = async (
  retry: FetchRetryByStatusOptions | undefined,
  response: Response,
  attemptCount: number
): Promise<{ type: "delay"; value: number } | { type: "timestamp"; value: number } | undefined> => {
  if (!retry) {
    return;
  }

  const strategy = await getRetryStrategyForResponse(response, retry);

  if (!strategy) {
    return;
  }

  switch (strategy.strategy) {
    case "backoff": {
      const value = calculateNextRetryDelay({ ...defaultRetryOptions, ...strategy }, attemptCount);

      if (value) {
        return { type: "delay", value };
      }

      break;
    }
    case "headers": {
      const resetAt = response.headers.get(strategy.resetHeader);

      if (typeof resetAt === "string") {
        const resetTimestamp = calculateResetAt(
          resetAt,
          strategy.resetFormat ?? "unix_timestamp_in_ms"
        );

        if (resetTimestamp) {
          return { type: "timestamp", value: resetTimestamp };
        }
      }

      break;
    }
  }

  return;
};

const getRetryStrategyForResponse = async (
  response: Response,
  retry: FetchRetryByStatusOptions
): Promise<FetchRetryStrategy | undefined> => {
  const statusCodes = Object.keys(retry);
  const clonedResponse = response.clone();

  for (let i = 0; i < statusCodes.length; i++) {
    const statusRange = statusCodes[i];

    if (!statusRange) {
      continue;
    }

    const strategy = retry[statusRange];

    if (!strategy) {
      continue;
    }

    if (isStatusCodeInRange(response.status, statusRange)) {
      if (strategy.bodyFilter) {
        const body = safeJsonParse(await clonedResponse.text());

        if (!body) {
          continue;
        }

        if (eventFilterMatches(body, strategy.bodyFilter)) {
          return strategy;
        } else {
          continue;
        }
      }

      return strategy;
    }
  }

  return;
};

/**
 * Checks if a given status code falls within a given range.
 * The range can be a single status code (e.g. "200"),
 * a range of status codes (e.g. "500-599"),
 * a range of status codes with a wildcard (e.g. "4xx" for any 4xx status code),
 * or a list of status codes separated by commas (e.g. "401,403,404,409-412,5xx").
 * Returns `true` if the status code falls within the range, and `false` otherwise.
 */
const isStatusCodeInRange = (statusCode: number, statusRange: string): boolean => {
  if (statusRange === "all") {
    return true;
  }

  if (statusRange.includes(",")) {
    const statusCodes = statusRange.split(",").map((s) => s.trim());

    return statusCodes.some((s) => isStatusCodeInRange(statusCode, s));
  }

  const [start, end] = statusRange.split("-");

  if (end) {
    return statusCode >= parseInt(start ?? "0", 10) && statusCode <= parseInt(end, 10);
  }

  if (start?.endsWith("xx")) {
    const prefix = start.slice(0, -2);
    const statusCodePrefix = Math.floor(statusCode / 100).toString();
    return statusCodePrefix === prefix;
  }

  if (!start) {
    return false;
  }

  const statusCodeString = statusCode.toString();
  const rangePrefix = start.slice(0, -1);

  if (start.endsWith("x") && statusCodeString.startsWith(rangePrefix)) {
    return true;
  }

  return statusCode === parseInt(start, 10);
};

const createAttributesFromHeaders = (headers: Headers): Attributes => {
  const attributes: Attributes = {};

  const normalizedHeaderKey = (key: string) => {
    return key.toLowerCase();
  };

  headers.forEach((value, key) => {
    attributes[`http.response.header.${normalizedHeaderKey(key)}`] = value;
  });

  return attributes;
};

const safeJsonParse = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
};

// This function will resolve the defaults of a property within an options object.
// If the options object is undefined, it will return the defaults for that property (passed in as the 3rd arg).
// if the options object is defined, and the property exists, then it will return the defaults if the value of the property is undefined or null
const resolveDefaults = <
  TObject extends Record<string, unknown>,
  K extends keyof TObject,
  TValue extends TObject[K],
>(
  obj: TObject | undefined,
  key: K,
  defaults: TValue
): TValue => {
  if (!obj) {
    return defaults;
  }

  if (obj[key] === undefined || obj[key] === null) {
    return defaults;
  }

  return obj[key] as TValue;
};

const createFetchAttributes = (
  input: RequestInfo | URL,
  init?: RetryFetchRequestInit | undefined
): Attributes => {
  const url = normalizeUrlFromInput(input);
  const httpMethod = normalizeHttpMethod(input, init);

  return {
    [SEMATTRS_HTTP_METHOD]: httpMethod,
    [SEMATTRS_HTTP_URL]: url.href,
    [SEMATTRS_HTTP_HOST]: url.hostname,
    ["server.host"]: url.hostname,
    ["server.port"]: url.port,
    [SEMATTRS_HTTP_SCHEME]: url.protocol.replace(":", ""),
    ...accessoryAttributes({
      items: [
        {
          text: url.hostname,
          variant: "normal",
        },
      ],
      style: "codepath",
    }),
  };
};

const createFetchResponseAttributes = (response: Response): Attributes => {
  return {
    [SEMATTRS_HTTP_STATUS_CODE]: response.status,
    "http.status_text": response.statusText,
    [SEMATTRS_HTTP_RESPONSE_CONTENT_LENGTH]: response.headers.get("content-length") || "0",
    ...createAttributesFromHeaders(response.headers),
  };
};

const createFetchRetryOptionsAttributes = (retry?: FetchRetryOptions): Attributes => {
  const byStatus = resolveDefaults(retry, "byStatus", defaultFetchRetryOptions.byStatus);
  const connectionError = resolveDefaults(
    retry,
    "connectionError",
    defaultFetchRetryOptions.connectionError
  );
  const timeout = resolveDefaults(retry, "timeout", defaultFetchRetryOptions.timeout);

  return {
    ...flattenAttributes(byStatus, "retry.byStatus"),
    ...flattenAttributes(connectionError, "retry.connectionError"),
    ...flattenAttributes(timeout, "retry.timeout"),
  };
};

export const retry = {
  onThrow,
  fetch: retryFetch,
};
