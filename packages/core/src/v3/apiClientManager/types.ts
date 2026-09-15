import type { ApiClientFutureFlags, ApiRequestOptions } from "../apiClient/index.js";

export type ApiClientConfiguration = {
  baseURL?: string;
  /**
   * @deprecated Use `accessToken` instead.
   */
  secretKey?: string;
  /**
   * The access token to authenticate with the Trigger API.
   */
  accessToken?: string;
  /**
   * Mints a fresh access token. Called when a realtime stream subscription is
   * rejected with a 401/403, so a long-lived subscription can survive the
   * expiry of the token it started with.
   */
  refreshAccessToken?: () => Promise<string>;
  /**
   * The preview branch name (for preview environments)
   */
  previewBranch?: string;
  /**
   * Pin every run triggered through this client to the deployment deployed under this
   * external id. An explicit `externalDeploymentId` on an individual trigger wins over it;
   * it in turn wins over `TRIGGER_EXTERNAL_DEPLOYMENT_ID` and platform discovery.
   */
  externalDeploymentId?: string;
  requestOptions?: ApiRequestOptions;
  future?: ApiClientFutureFlags;
};
