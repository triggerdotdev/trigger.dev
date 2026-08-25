type ErrorContext = Record<string, unknown>;

abstract class BaseError<TContext extends ErrorContext = ErrorContext> extends Error {
  public abstract readonly retry: boolean;
  public readonly cause: BaseError | undefined;
  public readonly context: TContext | undefined;
  public readonly message: string;
  public abstract readonly name: string;

  constructor(opts: { message: string; cause?: BaseError; context?: TContext }) {
    super(opts.message);
    this.message = opts.message;
    this.cause = opts.cause;
    this.context = opts.context;
  }

  public toString(): string {
    return `${this.name}: ${this.message} - ${JSON.stringify(
      this.context
    )} - caused by ${this.cause?.toString()}`;
  }
}

export class InsertError extends BaseError {
  public readonly retry = true;
  public readonly name = InsertError.name;
  /**
   * Untruncated ClickHouse error text, kept only so the JSON-parse recovery path
   * can read the `(at row N)` hint that `message` drops. Defined non-enumerable
   * on purpose: ClickHouse embeds a snippet of the offending row in its parse
   * errors, so this must not reach structured logs or error reporting, both of
   * which serialize own enumerable properties. Direct reads still work.
   */
  declare readonly rawMessage?: string;
  constructor(message: string, options?: { rawMessage?: string }) {
    super({
      message,
    });
    Object.defineProperty(this, "rawMessage", {
      value: options?.rawMessage,
      enumerable: false,
    });
  }
}
export class QueryError extends BaseError<{ query: string }> {
  public readonly retry = true;
  public readonly name = QueryError.name;
  /**
   * The underlying ClickHouse error type (e.g. `TIMEOUT_EXCEEDED`) when the failure came from
   * ClickHouse rejecting the query, else undefined. Lets callers distinguish a query that hit a
   * server-side resource limit from an unexpected failure.
   */
  public readonly clickhouseErrorType?: string;
  constructor(message: string, context: { query: string }, clickhouseErrorType?: string) {
    super({
      message,
      context,
    });
    this.clickhouseErrorType = clickhouseErrorType;
  }
}

/**
 * ClickHouse error types raised when a query exceeds a server-side resource limit
 * (`max_execution_time`, `max_memory_usage`, etc.). These mean the caller's query was too
 * expensive, not a service fault, so callers can turn them into an actionable 4xx.
 */
const CLICKHOUSE_RESOURCE_LIMIT_ERROR_TYPES = new Set([
  "MEMORY_LIMIT_EXCEEDED",
  "TIMEOUT_EXCEEDED",
  "TOO_SLOW",
  "TOO_MANY_ROWS",
  "TOO_MANY_BYTES",
  "TOO_MANY_ROWS_OR_BYTES",
]);

export function isClickhouseResourceLimitError(error: unknown): boolean {
  return (
    error instanceof QueryError &&
    error.clickhouseErrorType !== undefined &&
    CLICKHOUSE_RESOURCE_LIMIT_ERROR_TYPES.has(error.clickhouseErrorType)
  );
}
