export type ServiceValidationErrorLevel = "error" | "warn" | "info";

export class ServiceValidationError extends Error {
  constructor(
    message: string,
    public status?: number,
    public logLevel?: ServiceValidationErrorLevel
  ) {
    super(message);
    this.name = "ServiceValidationError";
  }
}

/**
 * Thrown when a trigger is rejected because the environment's queue is at its
 * maximum size. This is identified separately from other validation errors so
 * the batch queue worker can short-circuit retries and skip pre-failed run
 * creation for this specific overload scenario — see the batch process item
 * callback in `runEngineHandlers.server.ts`.
 */
export class QueueSizeLimitExceededError extends ServiceValidationError {
  constructor(
    message: string,
    public maximumSize: number,
    status?: number,
    logLevel?: ServiceValidationErrorLevel
  ) {
    super(message, status, logLevel);
    this.name = "QueueSizeLimitExceededError";
  }
}
