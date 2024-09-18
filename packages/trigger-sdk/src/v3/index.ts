export * from "./cache.js";
export * from "./config.js";
export { retry, type RetryOptions } from "./retry.js";
export { queue } from "./shared.js";
export * from "./tasks.js";
export * from "./wait.js";
export * from "./usage.js";
export * from "./idempotencyKeys.js";
export * from "./tags.js";
export type { Context };

import type { Context } from "./shared.js";

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

export { runs } from "./runs.js";
export * as schedules from "./schedules/index.js";
export * as envvars from "./envvars.js";
export type { ImportEnvironmentVariablesParams } from "./envvars.js";

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
