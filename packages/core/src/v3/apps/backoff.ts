import { setTimeout as timeout } from "node:timers/promises";

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
    this.name = "AttemptTimeout";
  }
}

class RetryLimitExceeded extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "RetryLimitExceeded";
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

  #clone(type?: ExponentialBackoffType, opts: Partial<ExponentialBackoffOptions> = {}) {
    return new ExponentialBackoff(type ?? this.#type, {
      base: opts.base ?? this.#base,
      factor: opts.factor ?? this.#factor,
      min: opts.min ?? this.#min,
      max: opts.max ?? this.#max,
      maxRetries: opts.maxRetries ?? this.#maxRetries,
      maxElapsed: opts.maxElapsed ?? this.#maxElapsed,
    });
  }

  type(type?: ExponentialBackoffType) {
    return this.#clone(type);
  }

  base(base?: number) {
    return this.#clone(undefined, { base });
  }

  factor(factor?: number) {
    return this.#clone(undefined, { factor });
  }

  min(min?: number) {
    return this.#clone(undefined, { min });
  }

  max(max?: number) {
    return this.#clone(undefined, { max });
  }

  maxRetries(maxRetries?: number) {
    return this.#clone(undefined, { maxRetries });
  }

  // TODO: With .execute(), should this also include the time it takes to execute the callback?
  maxElapsed(maxElapsed?: number) {
    return this.#clone(undefined, { maxElapsed });
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

  /** Returns the delay for the current retry in seconds. */
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

    // If min/max override the delay, jitter with 20% while respecting min/max
    if (delay < this.#min) {
      delay = this.#min + Math.random() * (this.#min * 0.2);
    }
    if (delay > this.#max) {
      delay = this.#max - Math.random() * (this.#max * 0.2);
    }

    delay = Math.round(delay);

    return delay;
  }

  /** Waits with the appropriate delay for the current retry. */
  async wait(retries: number = this.#retries, jitter: boolean = true) {
    if (retries > this.#maxRetries) {
      console.error(`Retry limit exceeded: ${retries} > ${this.#maxRetries}`);
      throw new RetryLimitExceeded();
    }

    const delay = this.delay(retries, jitter);

    return await timeout(delay * 1000);
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

  get state() {
    return {
      retries: this.#retries,
      type: this.#type,
      base: this.#base,
      factor: this.#factor,
      min: this.#min,
      max: this.#max,
      maxRetries: this.#maxRetries,
      maxElapsed: this.#maxElapsed,
    };
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

      if (retry > 0) {
        console.log(`Retrying in ${delay.milliseconds}ms`);
        await timeout(delay.milliseconds);
      }

      let attemptTimeout: NodeJS.Timeout | undefined = undefined;

      try {
        const result = await new Promise<T>(async (resolve, reject) => {
          if (attemptTimeoutMs > 0) {
            attemptTimeout = setTimeout(() => {
              reject(new AttemptTimeout());
            }, attemptTimeoutMs);
          }

          try {
            const callbackResult = await callback({ delay, retry, elapsedMs });

            resolve(callbackResult);
          } catch (error) {
            reject(error);
          }
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

  static RetryLimitExceeded = RetryLimitExceeded;
  static StopRetrying = StopRetrying;
}
