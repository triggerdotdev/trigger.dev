import { ConcurrentWaitError } from "../errors.js";

const concurrentWaitErrorMessage =
  "Parallel waits are not supported, e.g. using Promise.all() around our wait functions.";

export function preventMultipleWaits() {
  let isExecutingWait = false;

  return async <T>(cb: () => Promise<T>): Promise<T> => {
    if (isExecutingWait) {
      console.error(concurrentWaitErrorMessage);
      throw new ConcurrentWaitError(concurrentWaitErrorMessage);
    }

    isExecutingWait = true;

    try {
      return await cb();
    } finally {
      isExecutingWait = false;
    }
  };
}
