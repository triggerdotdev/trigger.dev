export * from "./cache";
export * from "./config";
export { retry, type RetryOptions } from "./retry";
export { queue } from "./shared";
export * from "./tasks";
export * from "./wait";
export * from "./usage";
export * from "./idempotencyKeys";
export type { Context };

import type { Context } from "./shared";

import type { ApiClientConfiguration } from "@trigger.dev/core/v3";
import { apiClientManager } from "@trigger.dev/core/v3";

export type { ApiClientConfiguration };

export {
  ApiError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
  AbortTaskRunError,
  logger,
  type LogLevel,
} from "@trigger.dev/core/v3";

export { runs } from "./runs";
export * as schedules from "./schedules";
export * as envvars from "./envvars";
export type { ImportEnvironmentVariablesParams } from "./envvars";

/**
 * Register the global API client configuration. Alternatively, you can set the `TRIGGER_SECRET_KEY` and `TRIGGER_API_URL` environment variables.
 * @param options The API client configuration.
 * @param options.baseURL The base URL of the Trigger API. (default: `https://api.trigger.dev`)
 * @param options.secretKey The secret key to authenticate with the Trigger API. (default: `process.env.TRIGGER_SECRET_KEY`) This can be found in your Trigger.dev project "API Keys" settings.
 *
 * @example
 *
 * ```typescript
 * import { configure } from "@trigger.dev/sdk/v3";
 *
 * configure({
 *  baseURL: "https://api.trigger.dev",
 *  secretKey: "tr_dev_1234567890"
 * });
 * ```
 */
export function configure(options: ApiClientConfiguration) {
  apiClientManager.setGlobalAPIClientConfiguration(options);
}
