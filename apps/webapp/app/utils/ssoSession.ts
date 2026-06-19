// Shared (server + client) constants for the SSO session-revalidation flow.

export const SSO_SESSION_INVALIDATED_HEADER = "x-sso-session-invalidated";

export const SSO_SESSION_EXPIRED_REASON = "session_expired";

// The reason rides as its own `?reason=` param, not `?redirectTo=/login...`,
// because the redirect sanitizer rejects /login and would drop it.
export function ssoSessionExpiredLogoutPath(): string {
  return `/logout?reason=${SSO_SESSION_EXPIRED_REASON}`;
}

export const SSO_SESSION_CHECK_PATH = "/resources/session-check";
