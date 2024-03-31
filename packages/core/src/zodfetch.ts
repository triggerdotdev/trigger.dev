import { z } from "zod";
import { RetryOptions, calculateNextRetryDelay, defaultRetryOptions } from "./v3";

export type ApiResult<TSuccessResult> =
  | { ok: true; data: TSuccessResult }
  | {
      ok: false;
      error: string;
    };

export type ZodFetchOptions = {
  retry?: RetryOptions;
};

export async function zodfetch<TResponseBody extends any>(
  schema: z.Schema<TResponseBody>,
  url: string,
  requestInit?: RequestInit,
  options?: ZodFetchOptions
): Promise<ApiResult<TResponseBody>> {
  return await _doZodFetch(schema, url, requestInit, options);
}

async function _doZodFetch<TResponseBody extends any>(
  schema: z.Schema<TResponseBody>,
  url: string,
  requestInit?: RequestInit,
  options?: ZodFetchOptions,
  attempt = 1
): Promise<ApiResult<TResponseBody>> {
  try {
    const response = await fetch(url, requestInit);

    if ((!requestInit || requestInit.method === "GET") && response.status === 404) {
      return {
        ok: false,
        error: `404: ${response.statusText}`,
      };
    }

    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      const body = await response.json();
      if (!body.error) {
        return { ok: false, error: "Something went wrong" };
      }

      return { ok: false, error: body.error };
    }

    // Retryable errors
    if (response.status === 429 || response.status >= 500) {
      if (!options?.retry) {
        return {
          ok: false,
          error: `Failed to fetch ${url}, got status code ${response.status}`,
        };
      }

      const retry = { ...defaultRetryOptions, ...options.retry };

      if (attempt > retry.maxAttempts) {
        return {
          ok: false,
          error: `Failed to fetch ${url}, got status code ${response.status}`,
        };
      }

      const delay = calculateNextRetryDelay(retry, attempt);

      await new Promise((resolve) => setTimeout(resolve, delay));

      return await _doZodFetch(schema, url, requestInit, options, attempt + 1);
    }

    if (response.status !== 200) {
      return {
        ok: false,
        error: `Failed to fetch ${url}, got status code ${response.status}`,
      };
    }

    const jsonBody = await response.json();
    const parsedResult = schema.safeParse(jsonBody);

    if (parsedResult.success) {
      return { ok: true, data: parsedResult.data };
    }

    if ("error" in jsonBody) {
      return {
        ok: false,
        error: typeof jsonBody.error === "string" ? jsonBody.error : JSON.stringify(jsonBody.error),
      };
    }

    return { ok: false, error: parsedResult.error.message };
  } catch (error) {
    if (options?.retry) {
      const retry = { ...defaultRetryOptions, ...options.retry };

      if (attempt > retry.maxAttempts) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : JSON.stringify(error),
        };
      }

      const delay = calculateNextRetryDelay(retry, attempt);

      await new Promise((resolve) => setTimeout(resolve, delay));

      return await _doZodFetch(schema, url, requestInit, options, attempt + 1);
    }

    return {
      ok: false,
      error: error instanceof Error ? error.message : JSON.stringify(error),
    };
  }
}
