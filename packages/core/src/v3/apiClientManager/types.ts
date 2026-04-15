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
   * Controls the `lockToVersion` applied to task triggers in this scope.
   *
   * - A version string (e.g. `"20250208.1"`) pins every trigger in the scope to that version.
   * - `null` explicitly unpins: `lockToVersion` is omitted from the request and the server
   *   resolves to the current deployed version. Ignores the `TRIGGER_VERSION` environment
   *   variable. Use this when triggering into a project where the ambient `TRIGGER_VERSION`
   *   does not apply (for example, cross-project triggers).
   * - Omitted (`undefined`) preserves the default behavior: per-call `version` option, then
   *   the `TRIGGER_VERSION` environment variable.
   *
   * A per-call `TriggerOptions.version` always wins over this scoped value.
   */
  version?: string | null;
  requestOptions?: ApiRequestOptions;
  future?: ApiClientFutureFlags;
};
