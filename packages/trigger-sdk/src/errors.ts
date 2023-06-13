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

export function isTriggerError(
  err: unknown
): err is ResumeWithTaskError | RetryWithTaskError {
  return (
    err instanceof ResumeWithTaskError || err instanceof RetryWithTaskError
  );
}
