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
