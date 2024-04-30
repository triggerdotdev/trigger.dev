import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { APIConnectionError, APIError } from "./apiErrors";
import { RetryOptions } from "./schemas";
import { calculateNextRetryDelay } from "./utils/retries";

export const defaultRetryOptions = {
  maxAttempts: 3,
  factor: 2,
  minTimeoutInMs: 1000,
  maxTimeoutInMs: 60000,
  randomize: false,
} satisfies RetryOptions;

export type ZodFetchOptions = {
  retry?: RetryOptions;
};

export async function zodfetch<T extends z.ZodTypeAny>(
  schema: T,
  url: string,
  requestInit?: RequestInit,
  options?: ZodFetchOptions
): Promise<z.infer<T>> {
  return await _doZodFetch(schema, url, requestInit, options);
}

async function _doZodFetch<TResponseBody extends any>(
  schema: z.Schema<TResponseBody>,
  url: string,
  requestInit?: RequestInit,
  options?: ZodFetchOptions,
  attempt = 1
): Promise<TResponseBody> {
  try {
    const response = await fetch(url, requestInitWithCache(requestInit));

    const responseHeaders = createResponseHeaders(response.headers);

    if (!response.ok) {
      const retryResult = shouldRetry(response, attempt, options?.retry);

      if (retryResult.retry) {
        await new Promise((resolve) => setTimeout(resolve, retryResult.delay));

        return await _doZodFetch(schema, url, requestInit, options, attempt + 1);
      } else {
        const errText = await response.text().catch((e) => castToError(e).message);
        const errJSON = safeJsonParse(errText);
        const errMessage = errJSON ? undefined : errText;

        throw APIError.generate(response.status, errJSON, errMessage, responseHeaders);
      }
    }

    const jsonBody = await response.json();
    const parsedResult = schema.safeParse(jsonBody);

    if (parsedResult.success) {
      return parsedResult.data;
    }

    throw fromZodError(parsedResult.error);
  } catch (error) {
    if (error instanceof APIError) {
      throw error;
    }

    if (options?.retry) {
      const retry = { ...defaultRetryOptions, ...options.retry };

      const delay = calculateNextRetryDelay(retry, attempt);

      if (delay) {
        await new Promise((resolve) => setTimeout(resolve, delay));

        return await _doZodFetch(schema, url, requestInit, options, attempt + 1);
      }
    }

    throw new APIConnectionError({ cause: castToError(error) });
  }
}

function castToError(err: any): Error {
  if (err instanceof Error) return err;
  return new Error(err);
}

type ShouldRetryResult =
  | {
      retry: false;
    }
  | {
      retry: true;
      delay: number;
    };

function shouldRetry(
  response: Response,
  attempt: number,
  retryOptions?: RetryOptions
): ShouldRetryResult {
  function shouldRetryForOptions(): ShouldRetryResult {
    const retry = { ...defaultRetryOptions, ...retryOptions };

    const delay = calculateNextRetryDelay(retry, attempt);

    if (delay) {
      return { retry: true, delay };
    } else {
      return { retry: false };
    }
  }

  // Note this is not a standard header.
  const shouldRetryHeader = response.headers.get("x-should-retry");

  // If the server explicitly says whether or not to retry, obey.
  if (shouldRetryHeader === "true") return shouldRetryForOptions();
  if (shouldRetryHeader === "false") return { retry: false };

  // Retry on request timeouts.
  if (response.status === 408) return shouldRetryForOptions();

  // Retry on lock timeouts.
  if (response.status === 409) return shouldRetryForOptions();

  // Retry on rate limits.
  if (response.status === 429) return shouldRetryForOptions();

  // Retry internal errors.
  if (response.status >= 500) return shouldRetryForOptions();

  return { retry: false };
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch (e) {
    return undefined;
  }
}

function createResponseHeaders(headers: Response["headers"]): Record<string, string> {
  return new Proxy(
    Object.fromEntries(
      // @ts-ignore
      headers.entries()
    ),
    {
      get(target, name) {
        const key = name.toString();
        return target[key.toLowerCase()] || target[key];
      },
    }
  );
}

function requestInitWithCache(requestInit?: RequestInit): RequestInit {
  try {
    const withCache: RequestInit = {
      ...requestInit,
      cache: "no-cache",
    };

    const _ = new Request("http://localhost", withCache);

    return withCache;
  } catch (error) {
    return requestInit ?? {};
  }
}
