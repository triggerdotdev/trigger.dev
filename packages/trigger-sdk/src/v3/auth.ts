import { type ApiClientConfiguration, apiClientManager } from "@trigger.dev/core/v3";
import { generateJWT as internal_generateJWT } from "@trigger.dev/core/v3";

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

export const auth = {
  configure,
  createPublicToken,
  withAuth,
};

type PublicTokenPermissionAction = "read"; // Add more actions as needed

type PublicTokenPermissionProperties = {
  tags?: string | string[];
  runs?: string | string[];
};

export type PublicTokenPermissions = {
  [key in PublicTokenPermissionAction]?: PublicTokenPermissionProperties | true;
};

export type CreatePublicTokenOptions = {
  permissions?: PublicTokenPermissions;
  expirationTime?: number | Date | string;
};

/**
 * Creates a public token using the provided options.
 *
 * @param options - Optional parameters for creating the public token.
 * @param options.permissions - An array of permissions to be included in the token.
 * @param options.expirationTime - The expiration time for the token.
 * @returns A promise that resolves to a string representing the generated public token.
 *
 * @example
 *
 * ```typescript
 * import { auth } from "@trigger.dev/sdk/v3";
 *
 * const publicToken = await auth.createPublicToken({
 *  permissions: {
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
      permissions: options?.permissions ? flattenPermissions(options.permissions) : undefined,
    },
    expirationTime: options?.expirationTime,
  });
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

function flattenPermissions(permissions: PublicTokenPermissions): string[] {
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
          }
        }
      }
    }
  }

  return flattenedPermissions;
}
