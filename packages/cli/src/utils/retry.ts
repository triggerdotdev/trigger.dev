import { wait } from "./wait";

type Options<TResult, TError> = {
  maxAttempts?: number;
  fn: (success: (result: TResult) => void, failed: (error: TError) => void) => Promise<void>;
  onSuccess?: (result: TResult) => void;
  onFailure?: (error: TError) => void;
};

export class Retry<TResult = any, TError = any> {
  private attempt = 0;

  constructor(private readonly options: Options<TResult, TError>) {}

  async run(at = 0): Promise<void> {
    this.attempt = 0;
    await this.#try();
  }

  async #try() {
    this.attempt++;
    try {
      await this.options.fn(this.success.bind(this), this.retry.bind(this));
    } catch (error) {
      if (this.attempt < (this.options.maxAttempts ?? 10)) {
        this.run();
        return;
      } else {
        this.options.onFailure?.(error as TError);
      }
    }
  }

  async retry(error: TError) {
    if (this.attempt < (this.options.maxAttempts ?? 10)) {
      const backoffTime = backoff(this.attempt);
      await wait(backoffTime);
      this.run();
    } else {
      this.options.onFailure?.(error as TError);
    }
  }

  async success(result: TResult) {
    this.options.onSuccess?.(result);
  }
}

const maximum_backoff = 30;
const initial_backoff = 0.2;
function backoff(attempt: number) {
  return Math.min((2 ^ attempt) * initial_backoff, maximum_backoff) * 1000;
}
