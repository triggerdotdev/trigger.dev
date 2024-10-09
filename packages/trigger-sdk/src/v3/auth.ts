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
  generateJWT,
};

export type GenerateJWTOptions = {
  permissions?: string[];
  expirationTime?: number | Date | string;
};

async function generateJWT(options?: GenerateJWTOptions): Promise<string> {
  const apiClient = apiClientManager.clientOrThrow();

  const claims = await apiClient.generateJWTClaims();

  return await internal_generateJWT({
    secretKey: apiClient.accessToken,
    payload: {
      ...claims,
      permissions: options?.permissions,
    },
    expirationTime: options?.expirationTime,
  });
}
