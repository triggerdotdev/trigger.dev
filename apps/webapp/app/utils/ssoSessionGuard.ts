import {
  SSO_SESSION_CHECK_PATH,
  SSO_SESSION_INVALIDATED_HEADER,
  ssoSessionExpiredLogoutPath,
} from "./ssoSession";

// Client-side counterpart to the SSO revalidation hook: programmatic
// requests can't follow the server's 302-to-/logout, so the server marks
// their 401 with a header that we watch for here and turn into a redirect.

let redirecting = false;

function redirectToSsoLogout() {
  if (redirecting) return;
  const { pathname } = window.location;
  if (pathname === "/logout" || pathname === "/login") return;
  redirecting = true;
  window.location.assign(ssoSessionExpiredLogoutPath());
}

export function installSsoSessionGuard() {
  if (typeof window === "undefined") return;
  const w = window as Window & { __ssoSessionGuardInstalled?: boolean };
  if (w.__ssoSessionGuardInstalled) return;
  w.__ssoSessionGuardInstalled = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const response = await originalFetch(...args);
    try {
      if (response.headers.get(SSO_SESSION_INVALIDATED_HEADER) === "1") {
        redirectToSsoLogout();
      }
    } catch {
      // Header access can throw on opaque responses; ours are same-origin.
    }
    return response;
  };
}

// Throttled because EventSource fires `error` on every transient reconnect.
let lastProbeAt = 0;
const PROBE_THROTTLE_MS = 5_000;

export function probeSsoSession() {
  if (typeof window === "undefined" || redirecting) return;
  const now = Date.now();
  if (now - lastProbeAt < PROBE_THROTTLE_MS) return;
  lastProbeAt = now;
  void fetch(SSO_SESSION_CHECK_PATH, { headers: { accept: "application/json" } }).catch(() => {});
}
