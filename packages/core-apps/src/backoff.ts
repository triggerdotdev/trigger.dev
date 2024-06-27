type ExponentialBackoffType = "NoJitter" | "FullJitter" | "EqualJitter";

type ExponentialBackoffOptions = {
  base: number;
  factor: number;
  min: number;
  max: number;
  maxRetries: number;
  maxElapsed: number;
};

class StopRetrying extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "StopRetrying";
  }
}

class AttemptTimeout extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "StopRetrying";
  }
}

type YieldType<T> = T extends AsyncGenerator<infer Y, any, any> ? Y : never;

/**
 * Exponential backoff helper class
 * - All time units in seconds unless otherwise specified
 */
export class ExponentialBackoff {
  #retries: number = 0;

  #type: ExponentialBackoffType;
  #base: number;
  #factor: number;

  #min: number;
  #max: number;

  #maxRetries: number;
  #maxElapsed: number;

  constructor(type?: ExponentialBackoffType, opts: Partial<ExponentialBackoffOptions> = {}) {
    this.#type = type ?? "NoJitter";
    this.#base = opts.base ?? 2;
    this.#factor = opts.factor ?? 1;

    this.#min = opts.min ?? -Infinity;
    this.#max = opts.max ?? Infinity;

    this.#maxRetries = opts.maxRetries ?? Infinity;
    this.#maxElapsed = opts.maxElapsed ?? Infinity;
  }

  #clone() {
    return new ExponentialBackoff(this.#type, {
      base: this.#base,
      factor: this.#factor,
      min: this.#min,
      max: this.#max,
      maxRetries: this.#maxRetries,
      maxElapsed: this.#maxElapsed,
    });
  }

  type(type?: ExponentialBackoffType) {
    if (typeof type !== "undefined") {
      this.#type = type;
    }
    return this.#clone();
  }

  base(base?: number) {
    if (typeof base !== "undefined") {
      this.#base = base;
    }
    return this.#clone();
  }

  factor(factor?: number) {
    if (typeof factor !== "undefined") {
      this.#factor = factor;
    }
    return this.#clone();
  }

  min(min?: number) {
    if (typeof min !== "undefined") {
      this.#min = min;
    }
    return this.#clone();
  }

  max(max?: number) {
    if (typeof max !== "undefined") {
      this.#max = max;
    }
    return this.#clone();
  }

  maxRetries(maxRetries?: number) {
    if (typeof maxRetries !== "undefined") {
      this.#maxRetries = maxRetries;
    }
    return this.#clone();
  }

  // TODO: With .execute(), should this also include the time it takes to execute the callback?
  maxElapsed(maxElapsed?: number) {
    if (typeof maxElapsed !== "undefined") {
      this.#maxElapsed = maxElapsed;
    }
    return this.#clone();
  }

  retries(retries?: number) {
    if (typeof retries !== "undefined") {
      if (retries > this.#maxRetries) {
        console.error(
          `Can't set retries ${retries} higher than maxRetries (${
            this.#maxRetries
          }), setting to maxRetries instead.`
        );
        this.#retries = this.#maxRetries;
      } else {
        this.#retries = retries;
      }
    }
    return this.#clone();
  }

  async *retryAsync(maxRetries: number = this.#maxRetries ?? Infinity) {
    let elapsed = 0;
    let retry = 0;

    while (retry <= maxRetries) {
      const delay = this.delay(retry);
      elapsed += delay;

      if (elapsed > this.#maxElapsed) {
        break;
      }

      yield {
        delay: {
          seconds: delay,
          milliseconds: delay * 1000,
        },
        retry,
      };

      retry++;
    }
  }

  async *[Symbol.asyncIterator]() {
    yield* this.retryAsync();
  }

  delay(retries: number = this.#retries, jitter: boolean = true) {
    if (retries > this.#maxRetries) {
      console.error(
        `Can't set retries ${retries} higher than maxRetries (${
          this.#maxRetries
        }), setting to maxRetries instead.`
      );
      retries = this.#maxRetries;
    }

    let delay = this.#factor * this.#base ** retries;

    switch (this.#type) {
      case "NoJitter": {
        break;
      }
      case "FullJitter": {
        if (!jitter) {
          delay = 0;
          break;
        }

        delay *= Math.random();
        break;
      }
      case "EqualJitter": {
        if (!jitter) {
          delay *= 0.5;
          break;
        }

        delay *= 0.5 * (1 + Math.random());
        break;
      }
      default: {
        throw new Error(`Unknown backoff type: ${this.#type}`);
      }
    }

    delay = Math.min(delay, this.#max);
    delay = Math.max(delay, this.#min);
    delay = Math.round(delay);

    return delay;
  }

  elapsed(retries: number = this.#retries, jitter: boolean = true) {
    let elapsed = 0;

    for (let i = 0; i <= retries; i++) {
      elapsed += this.delay(i, jitter);
    }

    const total = elapsed;

    let days = 0;
    if (elapsed > 3600 * 24) {
      days = Math.floor(elapsed / 3600 / 24);
      elapsed -= days * 3600 * 24;
    }

    let hours = 0;
    if (elapsed > 3600) {
      hours = Math.floor(elapsed / 3600);
      elapsed -= hours * 3600;
    }

    let minutes = 0;
    if (elapsed > 60) {
      minutes = Math.floor(elapsed / 60);
      elapsed -= minutes * 60;
    }

    const seconds = elapsed;

    return {
      seconds,
      minutes,
      hours,
      days,
      total,
    };
  }

  reset() {
    this.#retries = 0;
    return this;
  }

  next() {
    this.#retries++;
    return this.delay();
  }

  stop() {
    throw new StopRetrying();
  }

  async execute<T>(
    callback: (
      iteratorReturn: YieldType<ReturnType<ExponentialBackoff["retryAsync"]>> & {
        elapsedMs: number;
      }
    ) => Promise<T>,
    { attemptTimeoutMs = 0 }: { attemptTimeoutMs?: number } = {}
  ): Promise<
    | { success: true; result: T }
    | { success: false; error?: unknown; cause: "StopRetrying" | "Timeout" | "MaxRetries" }
  > {
    let elapsedMs = 0;
    let finalError: unknown = undefined;

    for await (const { delay, retry } of this) {
      const start = Date.now();

      let attemptTimeout: NodeJS.Timeout | undefined = undefined;

      try {
        const result = await new Promise<T>(async (resolve) => {
          if (attemptTimeoutMs > 0) {
            attemptTimeout = setTimeout(() => {
              throw new AttemptTimeout();
            }, attemptTimeoutMs);
          }

          const callbackResult = await callback({ delay, retry, elapsedMs });

          resolve(callbackResult);
        });

        return {
          success: true,
          result,
        };
      } catch (error) {
        finalError = error;

        if (error instanceof StopRetrying) {
          return {
            success: false,
            cause: "StopRetrying",
            error: error.message,
          };
        }

        if (error instanceof AttemptTimeout) {
          continue;
        }
      } finally {
        elapsedMs += Date.now() - start;
        clearTimeout(attemptTimeout);
      }
    }

    if (finalError instanceof AttemptTimeout) {
      return {
        success: false,
        cause: "Timeout",
      };
    } else {
      return {
        success: false,
        cause: "MaxRetries",
        error: finalError,
      };
    }
  }

  static StopRetrying = StopRetrying;
}
