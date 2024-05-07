import { DisplayProperty } from "@trigger.dev/core";
import { ErrorWithStack, SchemaError, ServerTask } from "@trigger.dev/core";

export class ResumeWithTaskError {
  constructor(public task: ServerTask) {}
}

export class ResumeWithParallelTaskError {
  constructor(
    public task: ServerTask,
    public childErrors: Array<TriggerInternalError>
  ) {}
}

export class RetryWithTaskError {
  constructor(
    public cause: ErrorWithStack,
    public task: ServerTask,
    public retryAt: Date
  ) {}
}

export class CanceledWithTaskError {
  constructor(public task: ServerTask) {}
}

export class YieldExecutionError {
  constructor(public key: string) {}
}

export class AutoYieldExecutionError {
  constructor(
    public location: string,
    public timeRemaining: number,
    public timeElapsed: number
  ) {}
}

export class AutoYieldWithCompletedTaskExecutionError {
  constructor(
    public id: string,
    public properties: DisplayProperty[] | undefined,
    public data: { location: string; timeRemaining: number; timeElapsed: number },
    public output?: string
  ) {}
}

export class ParsedPayloadSchemaError {
  constructor(public schemaErrors: SchemaError[]) {}
}

export type TriggerInternalError =
  | ResumeWithTaskError
  | RetryWithTaskError
  | CanceledWithTaskError
  | YieldExecutionError
  | AutoYieldExecutionError
  | AutoYieldWithCompletedTaskExecutionError
  | ResumeWithParallelTaskError;

/** Use this function if you're using a `try/catch` block to catch errors.
 * It checks if a thrown error is a special internal error that you should ignore.
 * If this returns `true` then you must rethrow the error: `throw err;`
 * @param err The error to check
 * @returns `true` if the error is a Trigger Error, `false` otherwise.
 */
export function isTriggerError(err: unknown): err is TriggerInternalError {
  return (
    err instanceof ResumeWithTaskError ||
    err instanceof RetryWithTaskError ||
    err instanceof CanceledWithTaskError ||
    err instanceof YieldExecutionError ||
    err instanceof AutoYieldExecutionError ||
    err instanceof AutoYieldWithCompletedTaskExecutionError ||
    err instanceof ResumeWithParallelTaskError
  );
}

// This error isn't an internal error but it can be used by the user to figure out which task caused the error
export class ErrorWithTask extends Error {
  constructor(
    public cause: ServerTask,
    message: string
  ) {
    super(message);
  }
}
