export type ErrorContext = Record<string, unknown>;

export abstract class BaseError<TContext extends ErrorContext = ErrorContext> extends Error {
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
  constructor(message: string) {
    super({
      message,
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
