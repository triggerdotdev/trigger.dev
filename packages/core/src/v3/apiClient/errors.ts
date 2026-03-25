export type APIHeaders = Record<string, string | null | undefined>;

export class ApiError extends Error {
  readonly status: number | undefined;
  readonly headers: APIHeaders | undefined;
  readonly error: Object | undefined;

  readonly code: string | null | undefined;
  readonly param: string | null | undefined;
  readonly type: string | undefined;

  constructor(
    status: number | undefined,
    error: Object | undefined,
    message: string | undefined,
    headers: APIHeaders | undefined
  ) {
    super(`${ApiError.makeMessage(status, error, message)}`);
    this.name = "TriggerApiError";
    this.status = status;
    this.headers = headers;

    const data = error as Record<string, any>;
    this.error = data;
    this.code = data?.["code"];
    this.param = data?.["param"];
    this.type = data?.["type"];
  }

  private static makeMessage(status: number | undefined, error: any, message: string | undefined) {
    const errorMessage = error?.message
      ? typeof error.message === "string"
        ? error.message
        : JSON.stringify(error.message)
      : typeof error === "string"
      ? error
      : error
      ? JSON.stringify(error)
      : undefined;

    if (errorMessage) {
      return errorMessage;
    }

    if (status && message) {
      return `${status} ${message}`;
    }

    if (status) {
      return `${status} status code (no body)`;
    }

    if (message) {
      return message;
    }

    return "(no status code or body)";
  }

  static generate(
    status: number | undefined,
    errorResponse: Object | undefined,
    message: string | undefined,
    headers: APIHeaders | undefined
  ) {
    if (!status) {
      return new ApiConnectionError({ cause: castToError(errorResponse) });
    }

    const error = (errorResponse as Record<string, any>)?.["error"];

    if (status === 400) {
      return new BadRequestError(status, error, message, headers);
    }

    if (status === 401) {
      return new AuthenticationError(status, error, message, headers);
    }

    if (status === 403) {
      return new PermissionDeniedError(status, error, message, headers);
    }

    if (status === 404) {
      return new NotFoundError(status, error, message, headers);
    }

    if (status === 409) {
      return new ConflictError(status, error, message, headers);
    }

    if (status === 422) {
      return new UnprocessableEntityError(status, error, message, headers);
    }

    if (status === 429) {
      return new RateLimitError(status, error, message, headers);
    }

    if (status >= 500) {
      return new InternalServerError(status, error, message, headers);
    }

    return new ApiError(status, error, message, headers);
  }
}

export class ApiConnectionError extends ApiError {
  override readonly status: undefined = undefined;

  constructor({ message, cause }: { message?: string; cause?: Error | undefined }) {
    super(undefined, undefined, message || "Connection error.", undefined);
    // in some environments the 'cause' property is already declared
    // @ts-ignore
    if (cause) this.cause = cause;
  }
}

export class BadRequestError extends ApiError {
  override readonly status: 400 = 400;
}

export class AuthenticationError extends ApiError {
  override readonly status: 401 = 401;
}

export class PermissionDeniedError extends ApiError {
  override readonly status: 403 = 403;
}

export class NotFoundError extends ApiError {
  override readonly status: 404 = 404;
}

export class ConflictError extends ApiError {
  override readonly status: 409 = 409;
}

export class UnprocessableEntityError extends ApiError {
  override readonly status: 422 = 422;
}

export class RateLimitError extends ApiError {
  override readonly status: 429 = 429;

  get millisecondsUntilReset(): number | undefined {
    // x-ratelimit-reset is the unix timestamp in milliseconds when the rate limit will reset.
    const resetAtUnixEpochMs = (this.headers ?? {})["x-ratelimit-reset"];

    if (typeof resetAtUnixEpochMs === "string") {
      const resetAtUnixEpoch = parseInt(resetAtUnixEpochMs, 10);

      if (isNaN(resetAtUnixEpoch)) {
        return;
      }

      // Add between 0 and 2000ms to the reset time to add jitter
      return Math.max(resetAtUnixEpoch - Date.now() + Math.floor(Math.random() * 2000), 0);
    }

    return;
  }
}

export class InternalServerError extends ApiError {}

export class ApiSchemaValidationError extends ApiError {
  override readonly status: 200 = 200;
  readonly rawBody: any;

  constructor({
    message,
    cause,
    status,
    rawBody,
    headers,
  }: {
    message?: string;
    cause?: Error | undefined;
    status: number;
    rawBody: any;
    headers: APIHeaders | undefined;
  }) {
    super(status, undefined, message || "Validation error.", headers);
    // in some environments the 'cause' property is already declared
    // @ts-ignore
    if (cause) this.cause = cause;

    this.rawBody = rawBody;
  }
}

/**
 * Error thrown when a batch stream completes but the batch was not sealed.
 * This indicates that not all expected items were received by the server.
 * The client should retry sending all items, or investigate the mismatch.
 */
export class BatchNotSealedError extends Error {
  readonly name = "BatchNotSealedError";

  /** The batch ID that was not sealed */
  readonly batchId: string;

  /** Number of items currently enqueued on the server */
  readonly enqueuedCount: number;

  /** Number of items expected to complete the batch */
  readonly expectedCount: number;

  /** Number of items accepted in this request */
  readonly itemsAccepted: number;

  /** Number of items deduplicated in this request */
  readonly itemsDeduplicated: number;

  constructor(options: {
    batchId: string;
    enqueuedCount: number;
    expectedCount: number;
    itemsAccepted: number;
    itemsDeduplicated: number;
  }) {
    const message = `Batch ${options.batchId} was not sealed: received ${options.enqueuedCount} of ${options.expectedCount} expected items (accepted: ${options.itemsAccepted}, deduplicated: ${options.itemsDeduplicated})`;
    super(message);

    this.batchId = options.batchId;
    this.enqueuedCount = options.enqueuedCount;
    this.expectedCount = options.expectedCount;
    this.itemsAccepted = options.itemsAccepted;
    this.itemsDeduplicated = options.itemsDeduplicated;
  }
}

function castToError(err: any): Error {
  if (err instanceof Error) return err;
  return new Error(err);
}
