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
  constructor(message: string, context: { query: string }) {
    super({
      message,
      context,
    });
  }
}
