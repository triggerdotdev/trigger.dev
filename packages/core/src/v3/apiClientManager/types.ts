import { type ApiRequestOptions } from "../apiClient/index.js";

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
  requestOptions?: ApiRequestOptions;
};
