import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { APIConnectionError, APIError } from "./apiErrors";
import { RetryOptions } from "./schemas";
import { calculateNextRetryDelay } from "./utils/retries";
import { FormDataEncoder } from "form-data-encoder";
import { Readable } from "node:stream";

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

export async function zodfetch<TResponseBodySchema extends z.ZodTypeAny>(
  schema: TResponseBodySchema,
  url: string,
  requestInit?: RequestInit,
  options?: ZodFetchOptions
): Promise<z.output<TResponseBodySchema>> {
  return await _doZodFetch(schema, url, requestInit, options);
}

export class MultipartBody {
  constructor(public body: any) {}
  get [Symbol.toStringTag](): string {
    return "MultipartBody";
  }
}

export async function zodupload<
  TResponseBodySchema extends z.ZodTypeAny,
  TBody = Record<string, unknown>,
>(
  schema: TResponseBodySchema,
  url: string,
  body: TBody,
  requestInit?: RequestInit,
  options?: ZodFetchOptions
): Promise<z.output<TResponseBodySchema>> {
  const form = await createForm(body);
  const encoder = new FormDataEncoder(form);

  const finalHeaders: Record<string, string> = {};

  for (const [key, value] of Object.entries(requestInit?.headers || {})) {
    finalHeaders[key] = value as string;
  }

  for (const [key, value] of Object.entries(encoder.headers)) {
    finalHeaders[key] = value;
  }

  finalHeaders["Content-Length"] = String(encoder.contentLength);

  const finalRequestInit: RequestInit = {
    ...requestInit,
    headers: finalHeaders,
    body: Readable.from(encoder) as any,
    // @ts-expect-error
    duplex: "half",
  };

  return await _doZodFetch(schema, url, finalRequestInit, options);
}

export const createForm = async <T = Record<string, unknown>>(
  body: T | undefined
): Promise<FormData> => {
  const form = new FormData();
  await Promise.all(
    Object.entries(body || {}).map(([key, value]) => addFormValue(form, key, value))
  );
  return form;
};

async function _doZodFetch<TResponseBodySchema extends z.ZodTypeAny>(
  schema: TResponseBodySchema,
  url: string,
  requestInit?: RequestInit,
  options?: ZodFetchOptions,
  attempt = 1
): Promise<z.output<TResponseBodySchema>> {
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

const addFormValue = async (form: FormData, key: string, value: unknown): Promise<void> => {
  if (value === undefined) return;
  if (value == null) {
    throw new TypeError(
      `Received null for "${key}"; to pass null in FormData, you must use the string 'null'`
    );
  }

  // TODO: make nested formats configurable
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    form.append(key, String(value));
  } else if (
    isUploadable(value) ||
    isBlobLike(value) ||
    value instanceof Buffer ||
    value instanceof ArrayBuffer
  ) {
    const file = await toFile(value);
    form.append(key, file as File);
  } else if (Array.isArray(value)) {
    await Promise.all(value.map((entry) => addFormValue(form, key + "[]", entry)));
  } else if (typeof value === "object") {
    await Promise.all(
      Object.entries(value).map(([name, prop]) => addFormValue(form, `${key}[${name}]`, prop))
    );
  } else {
    throw new TypeError(
      `Invalid value given to form, expected a string, number, boolean, object, Array, File or Blob but got ${value} instead`
    );
  }
};

export type ToFileInput = Uploadable | Exclude<BlobLikePart, string> | AsyncIterable<BlobLikePart>;

/**
 * Helper for creating a {@link File} to pass to an SDK upload method from a variety of different data formats
 * @param value the raw content of the file.  Can be an {@link Uploadable}, {@link BlobLikePart}, or {@link AsyncIterable} of {@link BlobLikePart}s
 * @param {string=} name the name of the file. If omitted, toFile will try to determine a file name from bits if possible
 * @param {Object=} options additional properties
 * @param {string=} options.type the MIME type of the content
 * @param {number=} options.lastModified the last modified timestamp
 * @returns a {@link File} with the given properties
 */
export async function toFile(
  value: ToFileInput | PromiseLike<ToFileInput>,
  name?: string | null | undefined,
  options?: FilePropertyBag | undefined
): Promise<FileLike> {
  // If it's a promise, resolve it.
  value = await value;

  // Use the file's options if there isn't one provided
  options ??= isFileLike(value) ? { lastModified: value.lastModified, type: value.type } : {};

  if (isResponseLike(value)) {
    const blob = await value.blob();
    name ||= new URL(value.url).pathname.split(/[\\/]/).pop() ?? "unknown_file";

    return new File([blob as any], name, options);
  }

  const bits = await getBytes(value);

  name ||= getName(value) ?? "unknown_file";

  if (!options.type) {
    const type = (bits[0] as any)?.type;
    if (typeof type === "string") {
      options = { ...options, type };
    }
  }

  return new File(bits, name, options);
}

function getName(value: any): string | undefined {
  return (
    getStringFromMaybeBuffer(value.name) ||
    getStringFromMaybeBuffer(value.filename) ||
    // For fs.ReadStream
    getStringFromMaybeBuffer(value.path)?.split(/[\\/]/).pop()
  );
}

const getStringFromMaybeBuffer = (x: string | Buffer | unknown): string | undefined => {
  if (typeof x === "string") return x;
  if (typeof Buffer !== "undefined" && x instanceof Buffer) return String(x);
  return undefined;
};

async function getBytes(value: ToFileInput): Promise<Array<BlobPart>> {
  let parts: Array<BlobPart> = [];
  if (
    typeof value === "string" ||
    ArrayBuffer.isView(value) || // includes Uint8Array, Buffer, etc.
    value instanceof ArrayBuffer
  ) {
    parts.push(value);
  } else if (isBlobLike(value)) {
    parts.push(await value.arrayBuffer());
  } else if (
    isAsyncIterableIterator(value) // includes Readable, ReadableStream, etc.
  ) {
    for await (const chunk of value) {
      parts.push(chunk as BlobPart); // TODO, consider validating?
    }
  } else {
    throw new Error(
      `Unexpected data type: ${typeof value}; constructor: ${value?.constructor
        ?.name}; props: ${propsForError(value)}`
    );
  }

  return parts;
}

function propsForError(value: any): string {
  const props = Object.getOwnPropertyNames(value);
  return `[${props.map((p) => `"${p}"`).join(", ")}]`;
}

const isAsyncIterableIterator = (value: any): value is AsyncIterableIterator<unknown> =>
  value != null && typeof value === "object" && typeof value[Symbol.asyncIterator] === "function";

/**
 * Intended to match web.Blob, node.Blob, node-fetch.Blob, etc.
 */
export interface BlobLike {
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Blob/size) */
  readonly size: number;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Blob/type) */
  readonly type: string;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Blob/text) */
  text(): Promise<string>;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Blob/slice) */
  slice(start?: number, end?: number): BlobLike;
  // unfortunately @types/node-fetch@^2.6.4 doesn't type the arrayBuffer method
}

/**
 * Intended to match web.File, node.File, node-fetch.File, etc.
 */
export interface FileLike extends BlobLike {
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/File/lastModified) */
  readonly lastModified: number;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/File/name) */
  readonly name: string;
}

/**
 * Intended to match web.Response, node.Response, node-fetch.Response, etc.
 */
export interface ResponseLike {
  url: string;
  blob(): Promise<BlobLike>;
}

export type Uploadable = FileLike | ResponseLike | Readable;

export const isResponseLike = (value: any): value is ResponseLike =>
  value != null &&
  typeof value === "object" &&
  typeof value.url === "string" &&
  typeof value.blob === "function";

export const isFileLike = (value: any): value is FileLike =>
  value != null &&
  typeof value === "object" &&
  typeof value.name === "string" &&
  typeof value.lastModified === "number" &&
  isBlobLike(value);

/**
 * The BlobLike type omits arrayBuffer() because @types/node-fetch@^2.6.4 lacks it; but this check
 * adds the arrayBuffer() method type because it is available and used at runtime
 */
export const isBlobLike = (
  value: any
): value is BlobLike & { arrayBuffer(): Promise<ArrayBuffer> } =>
  value != null &&
  typeof value === "object" &&
  typeof value.size === "number" &&
  typeof value.type === "string" &&
  typeof value.text === "function" &&
  typeof value.slice === "function" &&
  typeof value.arrayBuffer === "function";

export const isFsReadStream = (value: any): value is Readable => value instanceof Readable;

export const isUploadable = (value: any): value is Uploadable => {
  return isFileLike(value) || isResponseLike(value) || isFsReadStream(value);
};

export type BlobLikePart =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | BlobLike
  | Uint8Array
  | DataView;

export const isRecordLike = (value: any): value is Record<string, string> =>
  value != null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0 &&
  Object.keys(value).every((key) => typeof key === "string" && typeof value[key] === "string");
