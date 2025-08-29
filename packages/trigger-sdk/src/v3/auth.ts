import {
  type ApiClientConfiguration,
  apiClientManager,
  RealtimeRunSkipColumns,
} from "@trigger.dev/core/v3";
import { generateJWT as internal_generateJWT } from "@trigger.dev/core/v3";

/**
 * Register the global API client configuration. Alternatively, you can set the `TRIGGER_SECRET_KEY` and `TRIGGER_API_URL` environment variables.
 * @param options The API client configuration.
 * @param options.baseURL The base URL of the Trigger API. (default: `https://api.trigger.dev`)
 * @param options.accessToken The accessToken to authenticate with the Trigger API. (default: `process.env.TRIGGER_SECRET_KEY`) This can be found in your Trigger.dev project "API Keys" settings.
 *
 * @example
 *
 * ```typescript
 * import { configure } from "@trigger.dev/sdk/v3";
 *
 * configure({
 *  baseURL: "https://api.trigger.dev",
 *  accessToken: "tr_dev_1234567890"
 * });
 * ```
 */
export function configure(options: ApiClientConfiguration) {
  apiClientManager.setGlobalAPIClientConfiguration(options);
}

export const auth = {
  configure,
  createPublicToken,
  createTriggerPublicToken,
  createBatchTriggerPublicToken,
  withAuth,
  withPublicToken,
  withTriggerPublicToken,
  withBatchTriggerPublicToken,
};

type PublicTokenPermissionProperties = {
  /**
   * Grant access to specific tasks
   */
  tasks?: string | string[];

  /**
   * Grant access to specific run tags
   */
  tags?: string | string[];

  /**
   * Grant access to specific runs
   */
  runs?: string | string[] | true;

  /**
   * Grant access to specific batch runs
   */
  batch?: string | string[];

  /**
   * Grant access to specific waitpoints
   */
  waitpoints?: string | string[];
};

export type PublicTokenPermissions = {
  read?: PublicTokenPermissionProperties;

  write?: PublicTokenPermissionProperties;

  /**
   * Use auth.createTriggerPublicToken
   */
  trigger?: {
    tasks: string | string[];
  };

  /**
   * Use auth.createBatchTriggerPublicToken
   */
  batchTrigger?: {
    tasks: string | string[];
  };
};

export type CreatePublicTokenOptions = {
  /**
   * A collection of permission scopes to be granted to the token.
   *
   * @example
   *
   * ```typescript
   * scopes: {
   *   read: {
   *     tags: ["file:1234"]
   *   }
   * }
   * ```
   */
  scopes?: PublicTokenPermissions;

  /**
   * The expiration time for the token. This can be a number representing the time in milliseconds, a `Date` object, or a string.
   *
   * @example
   *
   * ```typescript
   * expirationTime: "1h"
   * ```
   */
  expirationTime?: number | Date | string;

  realtime?: {
    /**
     * Skip columns from the subscription.
     *
     * @default []
     *
     * @example
     * ```ts
     * auth.createPublicToken({
     *  realtime: {
     *    skipColumns: ["payload", "output"]
     *  }
     * });
     * ```
     */
    skipColumns?: RealtimeRunSkipColumns;
  };
};

/**
 * Creates a public token using the provided options.
 *
 * @param options - Optional parameters for creating the public token.
 * @param options.scopes - An array of permission scopes to be included in the token.
 * @param options.expirationTime - The expiration time for the token.
 * @param options.realtime - Options for realtime subscriptions.
 * @param options.realtime.skipColumns - Skip columns from the subscription.
 * @returns A promise that resolves to a string representing the generated public token.
 *
 * @example
 *
 * ```typescript
 * import { auth } from "@trigger.dev/sdk/v3";
 *
 * const publicToken = await auth.createPublicToken({
 *  scopes: {
 *   read: {
 *     tags: ["file:1234"]
 *   }
 * });
 * ```
 */
async function createPublicToken(options?: CreatePublicTokenOptions): Promise<string> {
  const apiClient = apiClientManager.clientOrThrow();

  const claims = await apiClient.generateJWTClaims();

  return await internal_generateJWT({
    secretKey: apiClient.accessToken,
    payload: {
      ...claims,
      scopes: options?.scopes ? flattenScopes(options.scopes) : undefined,
      realtime: options?.realtime,
    },
    expirationTime: options?.expirationTime,
  });
}

/**
 * Executes a function with a public token, providing temporary access permissions.
 *
 * @param options - Options for creating the public token.
 * @param fn - The asynchronous function to be executed with the public token.
 */
async function withPublicToken(options: CreatePublicTokenOptions, fn: () => Promise<void>) {
  const token = await createPublicToken(options);

  await withAuth({ accessToken: token }, fn);
}

export type CreateTriggerTokenOptions = {
  /**
   * The expiration time for the token. This can be a number representing the time in milliseconds, a `Date` object, or a string.
   *
   * @example
   *
   * ```typescript
   * expirationTime: "1h"
   * ```
   */
  expirationTime?: number | Date | string;

  /**
   * Whether the token can be used multiple times. By default trigger tokens are one-time use.
   * @default false
   */
  multipleUse?: boolean;

  realtime?: {
    /**
     * Skip columns from the subscription.
     *
     * @default []
     *
     * @example
     * ```ts
     * auth.createTriggerPublicToken("my-task", {
     *  realtime: {
     *    skipColumns: ["payload", "output"]
     *  }
     * });
     * ```
     */
    skipColumns?: RealtimeRunSkipColumns;
  };
};

/**
 * Creates a one-time use token to trigger a specific task.
 *
 * @param task - The task ID or an array of task IDs that the token should allow triggering.
 * @param options - Options for creating the one-time use token.
 * @returns A promise that resolves to a string representing the generated one-time use token.
 *
 * @example
 * Create a one-time use public token that allows triggering a specific task:
 *
 * ```ts
 * import { auth } from "@trigger.dev/sdk/v3";
 *
 * const token = await auth.createTriggerPublicToken("my-task");
 * ```
 *
 * @example You can also create a one-time use token that allows triggering multiple tasks:
 *
 * ```ts
 * import { auth } from "@trigger.dev/sdk/v3";
 *
 * const token = await auth.createTriggerPublicToken(["task1", "task2"]);
 * ```
 *
 * @example You can also create a one-time use token that allows triggering a task with a specific expiration time:
 *
 * ```ts
 * import { auth } from "@trigger.dev/sdk/v3";
 *
 * const token = await auth.createTriggerPublicToken("my-task", { expirationTime: "1h" });
 * ```
 */
async function createTriggerPublicToken(
  task: string | string[],
  options?: CreateTriggerTokenOptions
): Promise<string> {
  const apiClient = apiClientManager.clientOrThrow();

  const claims = await apiClient.generateJWTClaims();

  return await internal_generateJWT({
    secretKey: apiClient.accessToken,
    payload: {
      ...claims,
      otu: typeof options?.multipleUse === "boolean" ? !options.multipleUse : true,
      realtime: options?.realtime,
      scopes: flattenScopes({
        trigger: {
          tasks: task,
        },
      }),
    },
    expirationTime: options?.expirationTime,
  });
}

/**
 * Executes a function with a one-time use token that allows triggering a specific task.
 *
 * @param task - The task ID or an array of task IDs that the token should allow triggering.
 * @param options - Options for creating the one-time use token.
 * @param fn - The asynchronous function to be executed with the one-time use token.
 */
async function withTriggerPublicToken(
  task: string | string[],
  options: CreateTriggerTokenOptions = {},
  fn: () => Promise<void>
) {
  const token = await createTriggerPublicToken(task, options);

  await withAuth({ accessToken: token }, fn);
}

/**
 * Creates a one-time use token to batch trigger a specific task or tasks.
 *
 * @param task - The task ID or an array of task IDs that the token should allow triggering.
 * @param options - Options for creating the one-time use token.
 * @returns A promise that resolves to a string representing the generated one-time use token.
 *
 * @example
 *
 * ```ts
 * import { auth } from "@trigger.dev/sdk/v3";
 *
 * const token = await auth.createBatchTriggerPublicToken("my-task");
 * ```
 *
 * @example You can also create a one-time use token that allows batch triggering multiple tasks:
 *
 * ```ts
 * import { auth } from "@trigger.dev/sdk/v3";
 *
 * const token = await auth.createBatchTriggerPublicToken(["task1", "task2"]);
 * ```
 *
 * @example You can also create a one-time use token that allows batch triggering a task with a specific expiration time:
 *
 * ```ts
 * import { auth } from "@trigger.dev/sdk/v3";
 *
 * const token = await auth.createBatchTriggerPublicToken("my-task", { expirationTime: "1h" });
 * ```
 */
async function createBatchTriggerPublicToken(
  task: string | string[],
  options?: CreateTriggerTokenOptions
): Promise<string> {
  const apiClient = apiClientManager.clientOrThrow();

  const claims = await apiClient.generateJWTClaims();

  return await internal_generateJWT({
    secretKey: apiClient.accessToken,
    payload: {
      ...claims,
      otu: typeof options?.multipleUse === "boolean" ? !options.multipleUse : true,
      realtime: options?.realtime,
      scopes: flattenScopes({
        batchTrigger: {
          tasks: task,
        },
      }),
    },
    expirationTime: options?.expirationTime,
  });
}

/**
 * Executes a function with a one-time use token that allows triggering a specific task.
 *
 * @param task - The task ID or an array of task IDs that the token should allow triggering.
 * @param options - Options for creating the one-time use token.
 * @param fn - The asynchronous function to be executed with the one-time use token.
 */
async function withBatchTriggerPublicToken(
  task: string | string[],
  options: CreateTriggerTokenOptions = {},
  fn: () => Promise<void>
) {
  const token = await createBatchTriggerPublicToken(task, options);

  await withAuth({ accessToken: token }, fn);
}

/**
 * Executes a provided asynchronous function with a specified API client configuration.
 *
 * @template R - The type of the asynchronous function to be executed.
 * @param {ApiClientConfiguration} config - The configuration for the API client.
 * @param {R} fn - The asynchronous function to be executed.
 * @returns {Promise<ReturnType<R>>} A promise that resolves to the return type of the provided function.
 */
async function withAuth<R extends (...args: any[]) => Promise<any>>(
  config: ApiClientConfiguration,
  fn: R
): Promise<ReturnType<R>> {
  return apiClientManager.runWithConfig(config, fn);
}

function flattenScopes(permissions: PublicTokenPermissions): string[] {
  const flattenedPermissions: string[] = [];

  for (const [action, properties] of Object.entries(permissions)) {
    if (properties) {
      if (typeof properties === "boolean" && properties) {
        flattenedPermissions.push(action);
      } else if (typeof properties === "object") {
        for (const [property, value] of Object.entries(properties)) {
          if (Array.isArray(value)) {
            for (const item of value) {
              flattenedPermissions.push(`${action}:${property}:${item}`);
            }
          } else if (typeof value === "string") {
            flattenedPermissions.push(`${action}:${property}:${value}`);
          } else if (typeof value === "boolean" && value) {
            flattenedPermissions.push(`${action}:${property}`);
          }
        }
      }
    }
  }

  return flattenedPermissions;
}
