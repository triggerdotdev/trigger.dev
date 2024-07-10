import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { RetryOptions } from "../schemas";
import { calculateNextRetryDelay } from "../utils/retries";
import { ApiConnectionError, ApiError } from "./errors";

import { Attributes, Span } from "@opentelemetry/api";
import { SemanticInternalAttributes } from "../semanticInternalAttributes";
import { TriggerTracer } from "../tracer";
import { accessoryAttributes } from "../utils/styleAttributes";
import {
  CursorPage,
  CursorPageParams,
  CursorPageResponse,
  OffsetLimitPage,
  OffsetLimitPageParams,
  OffsetLimitPageResponse,
} from "./pagination";

export const defaultRetryOptions = {
  maxAttempts: 3,
  factor: 2,
  minTimeoutInMs: 1000,
  maxTimeoutInMs: 60000,
  randomize: false,
} satisfies RetryOptions;

export type ZodFetchOptions = {
  retry?: RetryOptions;
  tracer?: TriggerTracer;
  name?: string;
  attributes?: Attributes;
  icon?: string;
  onResponseBody?: (body: unknown, span: Span) => void;
};

export type ApiRequestOptions = Pick<ZodFetchOptions, "retry">;
type KeysEnum<T> = { [P in keyof Required<T>]: true };

// This is required so that we can determine if a given object matches the ApiRequestOptions
// type at runtime. While this requires duplication, it is enforced by the TypeScript
// compiler such that any missing / extraneous keys will cause an error.
const requestOptionsKeys: KeysEnum<ApiRequestOptions> = {
  retry: true,
};

export const isRequestOptions = (obj: unknown): obj is ApiRequestOptions => {
  return (
    typeof obj === "object" &&
    obj !== null &&
    !isEmptyObj(obj) &&
    Object.keys(obj).every((k) => hasOwn(requestOptionsKeys, k))
  );
};

interface FetchCursorPageParams extends CursorPageParams {
  query?: URLSearchParams;
}

interface FetchOffsetLimitPageParams extends OffsetLimitPageParams {
  query?: URLSearchParams;
}

export function zodfetch<TResponseBodySchema extends z.ZodTypeAny>(
  schema: TResponseBodySchema,
  url: string,
  requestInit?: RequestInit,
  options?: ZodFetchOptions
): ApiPromise<z.output<TResponseBodySchema>> {
  return new ApiPromise(_doZodFetch(schema, url, requestInit, options));
}

export function zodfetchCursorPage<TItemSchema extends z.ZodTypeAny>(
  schema: TItemSchema,
  url: string,
  params: FetchCursorPageParams,
  requestInit?: RequestInit,
  options?: ZodFetchOptions
) {
  const query = new URLSearchParams(params.query);

  if (params.limit) {
    query.set("page[size]", String(params.limit));
  }

  if (params.after) {
    query.set("page[after]", params.after);
  }

  if (params.before) {
    query.set("page[before]", params.before);
  }

  const cursorPageSchema = z.object({
    data: z.array(schema),
    pagination: z.object({
      next: z.string().optional(),
      previous: z.string().optional(),
    }),
  });

  const $url = new URL(url);
  $url.search = query.toString();

  const fetchResult = _doZodFetch(cursorPageSchema, $url.href, requestInit, options);

  return new CursorPagePromise(fetchResult, schema, url, params, requestInit, options);
}

export function zodfetchOffsetLimitPage<TItemSchema extends z.ZodTypeAny>(
  schema: TItemSchema,
  url: string,
  params: FetchOffsetLimitPageParams,
  requestInit?: RequestInit,
  options?: ZodFetchOptions
) {
  const query = new URLSearchParams(params.query);

  if (params.limit) {
    query.set("perPage", String(params.limit));
  }

  if (params.page) {
    query.set("page", String(params.page));
  }

  const offsetLimitPageSchema = z.object({
    data: z.array(schema),
    pagination: z.object({
      currentPage: z.coerce.number(),
      totalPages: z.coerce.number(),
      count: z.coerce.number(),
    }),
  });

  const $url = new URL(url);
  $url.search = query.toString();

  const fetchResult = _doZodFetch(offsetLimitPageSchema, $url.href, requestInit, options);

  return new OffsetLimitPagePromise(fetchResult, schema, url, params, requestInit, options);
}

type ZodFetchResult<T> = {
  data: T;
  response: Response;
};

type PromiseOrValue<T> = T | Promise<T>;

async function traceZodFetch<T>(
  params: {
    url: string;
    requestInit?: RequestInit;
    options?: ZodFetchOptions;
  },
  callback: (span?: Span) => Promise<T>
): Promise<T> {
  if (!params.options?.tracer) {
    return callback();
  }

  const url = new URL(params.url);
  const method = params.requestInit?.method ?? "GET";
  const name = params.options.name ?? `${method} ${url.pathname}`;

  return await params.options.tracer.startActiveSpan(
    name,
    async (span) => {
      return await callback(span);
    },
    {
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: params.options?.icon ?? "api",
        ...params.options.attributes,
      },
    }
  );
}

async function _doZodFetch<TResponseBodySchema extends z.ZodTypeAny>(
  schema: TResponseBodySchema,
  url: string,
  requestInit?: PromiseOrValue<RequestInit>,
  options?: ZodFetchOptions
): Promise<ZodFetchResult<z.output<TResponseBodySchema>>> {
  const $requestInit = await requestInit;

  return traceZodFetch({ url, requestInit: $requestInit, options }, async (span) => {
    const result = await _doZodFetchWithRetries(schema, url, $requestInit, options);

    if (options?.onResponseBody && span) {
      options.onResponseBody(result.data, span);
    }

    return result;
  });
}

async function _doZodFetchWithRetries<TResponseBodySchema extends z.ZodTypeAny>(
  schema: TResponseBodySchema,
  url: string,
  requestInit?: RequestInit,
  options?: ZodFetchOptions,
  attempt = 1
): Promise<ZodFetchResult<z.output<TResponseBodySchema>>> {
  try {
    const response = await fetch(url, requestInitWithCache(requestInit));

    const responseHeaders = createResponseHeaders(response.headers);

    if (!response.ok) {
      const retryResult = shouldRetry(response, attempt, options?.retry);

      if (retryResult.retry) {
        await waitForRetry(url, attempt + 1, retryResult.delay, options, requestInit, response);

        return await _doZodFetchWithRetries(schema, url, requestInit, options, attempt + 1);
      } else {
        const errText = await response.text().catch((e) => castToError(e).message);
        const errJSON = safeJsonParse(errText);
        const errMessage = errJSON ? undefined : errText;

        throw ApiError.generate(response.status, errJSON, errMessage, responseHeaders);
      }
    }

    const jsonBody = await response.json();
    const parsedResult = schema.safeParse(jsonBody);

    if (parsedResult.success) {
      return { data: parsedResult.data, response };
    }

    throw fromZodError(parsedResult.error);
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (options?.retry) {
      const retry = { ...defaultRetryOptions, ...options.retry };

      const delay = calculateNextRetryDelay(retry, attempt);

      if (delay) {
        await waitForRetry(url, attempt + 1, delay, options, requestInit);

        return await _doZodFetchWithRetries(schema, url, requestInit, options, attempt + 1);
      }
    }

    throw new ApiConnectionError({ cause: castToError(error) });
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
  if (response.status === 429) {
    if (
      attempt >= (typeof retryOptions?.maxAttempts === "number" ? retryOptions?.maxAttempts : 3)
    ) {
      return { retry: false };
    }

    // x-ratelimit-reset is the unix timestamp in milliseconds when the rate limit will reset.
    const resetAtUnixEpochMs = response.headers.get("x-ratelimit-reset");

    if (resetAtUnixEpochMs) {
      const resetAtUnixEpoch = parseInt(resetAtUnixEpochMs, 10);
      const delay = resetAtUnixEpoch - Date.now() + Math.floor(Math.random() * 1000);

      if (delay > 0) {
        return { retry: true, delay };
      }
    }

    return shouldRetryForOptions();
  }

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

/**
 * A subclass of `Promise` providing additional helper methods
 * for interacting with the SDK.
 */
export class ApiPromise<T> extends Promise<T> {
  constructor(private responsePromise: Promise<ZodFetchResult<T>>) {
    super((resolve) => {
      // this is maybe a bit weird but this has to be a no-op to not implicitly
      // parse the response body; instead .then, .catch, .finally are overridden
      // to parse the response
      resolve(null as any);
    });
  }

  /**
   * Gets the raw `Response` instance instead of parsing the response
   * data.
   *
   * If you want to parse the response body but still get the `Response`
   * instance, you can use {@link withResponse()}.
   */
  asResponse(): Promise<Response> {
    return this.responsePromise.then((p) => p.response);
  }

  /**
   * Gets the parsed response data and the raw `Response` instance.
   *
   * If you just want to get the raw `Response` instance without parsing it,
   * you can use {@link asResponse()}.
   */
  async withResponse(): Promise<{ data: T; response: Response }> {
    const [data, response] = await Promise.all([this.parse(), this.asResponse()]);
    return { data, response };
  }

  private parse(): Promise<T> {
    return this.responsePromise.then((result) => result.data);
  }

  override then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): Promise<TResult1 | TResult2> {
    return this.parse().then(onfulfilled, onrejected);
  }

  override catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null
  ): Promise<T | TResult> {
    return this.parse().catch(onrejected);
  }

  override finally(onfinally?: (() => void) | undefined | null): Promise<T> {
    return this.parse().finally(onfinally);
  }
}

export class CursorPagePromise<TItemSchema extends z.ZodTypeAny>
  extends ApiPromise<CursorPage<z.output<TItemSchema>>>
  implements AsyncIterable<z.output<TItemSchema>>
{
  constructor(
    result: Promise<ZodFetchResult<CursorPageResponse<z.output<TItemSchema>>>>,
    private schema: TItemSchema,
    private url: string,
    private params: FetchCursorPageParams,
    private requestInit?: RequestInit,
    private options?: ZodFetchOptions
  ) {
    super(
      result.then((result) => ({
        data: new CursorPage(result.data.data, result.data.pagination, this.#fetchPage.bind(this)),
        response: result.response,
      }))
    );
  }

  #fetchPage(params: Omit<CursorPageParams, "limit">): Promise<CursorPage<z.output<TItemSchema>>> {
    return zodfetchCursorPage(
      this.schema,
      this.url,
      { ...this.params, ...params },
      this.requestInit,
      this.options
    );
  }

  /**
   * Allow auto-paginating iteration on an unawaited list call, eg:
   *
   *    for await (const item of client.items.list()) {
   *      console.log(item)
   *    }
   */
  async *[Symbol.asyncIterator]() {
    const page = await this;
    for await (const item of page) {
      yield item;
    }
  }
}

export class OffsetLimitPagePromise<TItemSchema extends z.ZodTypeAny>
  extends ApiPromise<OffsetLimitPage<z.output<TItemSchema>>>
  implements AsyncIterable<z.output<TItemSchema>>
{
  constructor(
    result: Promise<ZodFetchResult<OffsetLimitPageResponse<z.output<TItemSchema>>>>,
    private schema: TItemSchema,
    private url: string,
    private params: FetchOffsetLimitPageParams,
    private requestInit?: RequestInit,
    private options?: ZodFetchOptions
  ) {
    super(
      result.then((result) => ({
        data: new OffsetLimitPage(
          result.data.data,
          result.data.pagination,
          this.#fetchPage.bind(this)
        ),
        response: result.response,
      }))
    );
  }

  #fetchPage(
    params: Omit<FetchOffsetLimitPageParams, "limit">
  ): Promise<OffsetLimitPage<z.output<TItemSchema>>> {
    return zodfetchOffsetLimitPage(
      this.schema,
      this.url,
      { ...this.params, ...params },
      this.requestInit,
      this.options
    );
  }

  /**
   * Allow auto-paginating iteration on an unawaited list call, eg:
   *
   *    for await (const item of client.items.list()) {
   *      console.log(item)
   *    }
   */
  async *[Symbol.asyncIterator]() {
    const page = await this;
    for await (const item of page) {
      yield item;
    }
  }
}

async function waitForRetry(
  url: string,
  attempt: number,
  delay: number,
  options?: ZodFetchOptions,
  requestInit?: RequestInit,
  response?: Response
): Promise<void> {
  if (options?.tracer) {
    const method = requestInit?.method ?? "GET";

    return options.tracer.startActiveSpan(
      response ? `wait after ${response.status}` : `wait after error`,
      async (span) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
      },
      {
        attributes: {
          [SemanticInternalAttributes.STYLE_ICON]: "wait",
          ...accessoryAttributes({
            items: [
              {
                text: `retrying ${options?.name ?? method.toUpperCase()} in ${delay}ms`,
                variant: "normal",
              },
            ],
            style: "codepath",
          }),
        },
      }
    );
  }

  await new Promise((resolve) => setTimeout(resolve, delay));
}

// https://stackoverflow.com/a/34491287
export function isEmptyObj(obj: Object | null | undefined): boolean {
  if (!obj) return true;
  for (const _k in obj) return false;
  return true;
}

// https://eslint.org/docs/latest/rules/no-prototype-builtins
export function hasOwn(obj: Object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
