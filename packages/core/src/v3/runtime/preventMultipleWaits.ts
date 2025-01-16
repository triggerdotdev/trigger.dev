import { InternalError } from "../errors.js";
import { TaskRunErrorCodes } from "../schemas/common.js";

const concurrentWaitErrorMessage =
  "Parallel waits are not supported, e.g. using Promise.all() around our wait functions.";

export function preventMultipleWaits() {
  let isExecutingWait = false;

  return async <T>(cb: () => Promise<T>): Promise<T> => {
    if (isExecutingWait) {
      console.error(concurrentWaitErrorMessage);
      throw new InternalError({
        code: TaskRunErrorCodes.TASK_DID_CONCURRENT_WAIT,
        message: concurrentWaitErrorMessage,
        skipRetrying: true,
        showStackTrace: false,
      });
    }

    isExecutingWait = true;

    try {
      return await cb();
    } finally {
      isExecutingWait = false;
    }
  };
}
