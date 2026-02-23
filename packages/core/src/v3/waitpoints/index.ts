import type { WaitpointTokenTypedResult } from "../schemas/common.js";

export class WaitpointTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaitpointTimeoutError";
  }
}

export class ManualWaitpointPromise<TOutput> extends Promise<
  WaitpointTokenTypedResult<TOutput>
> {
  constructor(
    executor: (
      resolve: (
        value:
          | WaitpointTokenTypedResult<TOutput>
          | PromiseLike<WaitpointTokenTypedResult<TOutput>>
      ) => void,
      reject: (reason?: any) => void
    ) => void
  ) {
    super(executor);
  }

  unwrap(): Promise<TOutput> {
    return this.then((result) => {
      if (result.ok) {
        return result.output;
      } else {
        throw new WaitpointTimeoutError(result.error.message);
      }
    });
  }
}
