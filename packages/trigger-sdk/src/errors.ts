import { ErrorWithStack, ServerTask } from "@trigger.dev/internal";

export class ResumeWithTaskError {
  constructor(public task: ServerTask) {}
}

export class RetryWithTaskError {
  constructor(
    public cause: ErrorWithStack,
    public task: ServerTask,
    public retryAt: Date
  ) {}
}

/** Use this function if you're using a `try/catch` block to catch errors.
 * It checks if a thrown error is a special internal error that you should ignore.
 * If this returns `true` then you must rethrow the error: `throw err;`
 * @param err The error to check
 * @returns `true` if the error is a Trigger Error, `false` otherwise.
 */
export function isTriggerError(
  err: unknown
): err is ResumeWithTaskError | RetryWithTaskError {
  return (
    err instanceof ResumeWithTaskError || err instanceof RetryWithTaskError
  );
}
