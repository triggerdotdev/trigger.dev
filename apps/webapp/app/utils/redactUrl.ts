// Credential query params redacted from logs and traces (some webhooks can only
// auth via a URL token).
export const SENSITIVE_QUERY_PARAMS = ["token", "secret", "access_token", "api_key"];

/**
 * Replace sensitive query param values with `[redacted]`. Accepts absolute or
 * path+query URLs; returns malformed input unchanged (never throws).
 */
export function redactSensitiveQueryParams(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) {
    return url;
  }

  try {
    const params = new URLSearchParams(url.slice(queryStart + 1));
    let didRedact = false;
    for (const key of SENSITIVE_QUERY_PARAMS) {
      if (params.has(key)) {
        params.set(key, "[redacted]");
        didRedact = true;
      }
    }
    return didRedact ? `${url.slice(0, queryStart)}?${params.toString()}` : url;
  } catch {
    return url;
  }
}
