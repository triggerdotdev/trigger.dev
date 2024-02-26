import {
  FetchRetryOptions,
  FetchRetryStrategy,
  RetryOptions,
  SemanticInternalAttributes,
  accessoryAttributes,
  calculateNextRetryTimestamp,
  defaultRetryOptions,
  runtime,
  eventFilterMatches,
  calculateResetAt,
  FetchTimeoutOptions,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer";
import { SemanticAttributes } from "@opentelemetry/semantic-conventions";
import { AsyncLocalStorage } from "node:async_hooks";
import { SpanStatusCode } from "@opentelemetry/api";
import type { HttpHandler } from "msw";

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
        try {
          return await tracer.startActiveSpan(
            "retry.fn()",
            async (span) => {
              return await fn({ attempt, maxAttempts: opts.maxAttempts });
            },
            {
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
            }
          );
        } catch (e) {
          const nextRetry = calculateNextRetryTimestamp(opts, attempt);

          if (!nextRetry) {
            throw e;
          }

          await runtime.waitUntil(new Date(nextRetry));
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
  timeout?: FetchTimeoutOptions;
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

const fetchHttpHandlerStorage = new AsyncLocalStorage<Array<HttpHandler>>();

const fetchWithInterceptors = async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  const handlers = fetchHttpHandlerStorage.getStore();

  if (handlers) {
    try {
      const { getResponse } = await import("msw");

      const request = new Request(input, init);

      const response = await getResponse(handlers, request);

      if (response) {
        return response;
      }
    } catch (e) {
      // Do nothing
      return fetch(input, init);
    }
  }

  return fetch(input, init);
};

const doFetchRequest = async (
  input: RequestInfo | URL | string,
  init?: RequestInit,
  attemptCount: number = 0
): Promise<Response> => {
  const url = normalizeUrlFromInput(input);
  const httpMethod = normalizeHttpMethod(input, init);

  return tracer.startActiveSpan(
    httpMethod,
    async (span) => {
      const response = await fetchWithInterceptors(input, {
        ...init,
        headers: {
          ...init?.headers,
          "x-retry-count": attemptCount.toString(),
        },
      });

      span.setAttribute(SemanticAttributes.HTTP_STATUS_CODE, response.status);
      span.setAttribute(
        SemanticAttributes.HTTP_RESPONSE_CONTENT_LENGTH,
        response.headers.get("content-length") || "0"
      );

      if (!response.ok) {
        span.recordException(`${response.status}: ${response.statusText}`);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `${response.status}: ${response.statusText}`,
        });
      }

      return response;
    },
    {
      attributes: {
        [SemanticAttributes.HTTP_METHOD]: httpMethod,
        [SemanticAttributes.HTTP_URL]: url.href,
        [SemanticAttributes.HTTP_HOST]: url.hostname,
        ["server.host"]: url.hostname,
        ["server.port"]: url.port,
        [SemanticAttributes.HTTP_SCHEME]: url.protocol.replace(":", ""),
        [SemanticInternalAttributes.STYLE_ICON]: "world",
        ...accessoryAttributes({
          items: [
            {
              text: `${url.hostname}${url.pathname}`,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
        ...(attemptCount > 1 ? { ["http.request.resend_count"]: attemptCount - 1 } : {}),
      },
    }
  );
};

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

          const timeoutId = init?.timeout?.durationInMs
            ? setTimeout(
                () => {
                  abortController.abort();
                },
                init?.timeout?.durationInMs
              )
            : undefined;

          init?.signal?.addEventListener("abort", () => {
            abortController.abort();
          });

          const response = await doFetchRequest(
            input,
            { ...(init ?? {}), signal: abortController.signal },
            attempt
          );

          if (timeoutId) {
            clearTimeout(timeoutId);
          }

          if (response.ok) {
            return response;
          }

          const nextRetry = await calculateRetryForResponse(init?.retry, response, attempt);

          if (!nextRetry) {
            return response;
          }

          if (attempt >= MAX_ATTEMPTS) {
            return response;
          }

          await tracer.startActiveSpan(
            "wait",
            async (span) => {
              await runtime.waitUntil(new Date(nextRetry));
            },
            {
              attributes: {
                [SemanticInternalAttributes.STYLE_ICON]: "clock",
                [SemanticInternalAttributes.RETRY_AT]: new Date(nextRetry).toISOString(),
                [SemanticInternalAttributes.RETRY_COUNT]: attempt,
              },
            }
          );
        } catch (e) {
          if (e instanceof Error && e.name === "AbortError") {
            const nextRetry = calculateNextRetryTimestamp(
              { ...defaultRetryOptions, ...(init?.timeout?.retry ?? {}) },
              attempt
            );

            if (!nextRetry) {
              throw e;
            }

            await tracer.startActiveSpan(
              "wait",
              async (span) => {
                await runtime.waitUntil(new Date(nextRetry));
              },
              {
                attributes: {
                  [SemanticInternalAttributes.STYLE_ICON]: "clock",
                  [SemanticInternalAttributes.RETRY_AT]: new Date(nextRetry).toISOString(),
                  [SemanticInternalAttributes.RETRY_COUNT]: attempt,
                },
              }
            );

            continue; // Move to the next attempt
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
      },
    }
  );
}

const calculateRetryForResponse = async (
  retry: FetchRetryOptions | undefined,
  response: Response,
  attemptCount: number
): Promise<number | undefined> => {
  if (!retry) {
    return;
  }

  const strategy = await getRetryStrategyForResponse(response, retry);

  if (!strategy) {
    return;
  }

  switch (strategy.strategy) {
    case "backoff": {
      return calculateNextRetryTimestamp({ ...defaultRetryOptions, ...strategy }, attemptCount);
    }
    case "headers": {
      const resetAt = response.headers.get(strategy.resetHeader);

      if (typeof resetAt === "string") {
        return calculateResetAt(resetAt, strategy.resetFormat ?? "unix_timestamp_in_ms");
      }
    }
  }
};

const getRetryStrategyForResponse = async (
  response: Response,
  retry: FetchRetryOptions
): Promise<FetchRetryStrategy | undefined> => {
  const statusCodes = Object.keys(retry);
  const clonedResponse = response.clone();

  for (let i = 0; i < statusCodes.length; i++) {
    const statusRange = statusCodes[i];
    const strategy = retry[statusRange];

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
};

/**
 * Checks if a given status code falls within a given range.
 * The range can be a single status code (e.g. "200"),
 * a range of status codes (e.g. "500-599"),
 * a range of status codes with a wildcard (e.g. "4xx" for any 4xx status code),
 * or a list of status codes separated by commas (e.g. "401,403,404").
 * Returns `true` if the status code falls within the range, and `false` otherwise.
 */
const isStatusCodeInRange = (statusCode: number, statusRange: string): boolean => {
  if (statusRange === "all") {
    return true;
  }

  if (statusRange.includes(",")) {
    const statusCodes = statusRange.split(",").map((s) => s.trim());
    return statusCodes.includes(statusCode.toString());
  }

  const [start, end] = statusRange.split("-");

  if (end) {
    return statusCode >= parseInt(start, 10) && statusCode <= parseInt(end, 10);
  }

  if (start.endsWith("xx")) {
    const prefix = start.slice(0, -2);
    const statusCodePrefix = Math.floor(statusCode / 100).toString();
    return statusCodePrefix === prefix;
  }

  const statusCodeString = statusCode.toString();
  const rangePrefix = start.slice(0, -1);

  if (start.endsWith("x") && statusCodeString.startsWith(rangePrefix)) {
    return true;
  }

  return statusCode === parseInt(start, 10);
};

const safeJsonParse = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
};

const interceptFetch = (...handlers: Array<HttpHandler>) => {
  return {
    run: async <T>(fn: (...args: any[]) => Promise<T>): Promise<T> => {
      const current = fetchHttpHandlerStorage.getStore();

      if (current) {
        current.push(...handlers);
        return fn();
      } else {
        return fetchHttpHandlerStorage.run(handlers, fn);
      }
    },
  };
};

export const retry = {
  onThrow,
  fetch: retryFetch,
  interceptFetch,
};
