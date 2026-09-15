const DEFAULT_REDIRECT = "/";

// Pathnames that are NOT user-navigable destinations: fetcher endpoints,
// OAuth/auth callbacks, JSON APIs, the magic-link redemption route, and the
// auth flow routes themselves (which would create a redirect loop). Note
// `/admin/api/` covers admin JSON endpoints while leaving `/admin`,
// `/admin/back-office/*`, `/admin/orgs`, etc. navigable.
const NON_NAVIGABLE_PREFIXES = ["/resources/", "/auth/", "/admin/api/", "/api/", "/engine/"];
const NON_NAVIGABLE_EXACT = new Set([
  "/magic",
  "/logout",
  "/login",
  "/login/magic",
  "/login/mfa",
  "/login/sso",
]);

function isNavigablePath(pathname: string): boolean {
  if (NON_NAVIGABLE_EXACT.has(pathname)) return false;
  return !NON_NAVIGABLE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * This should be used any time the redirect path is user-provided
 * (Like the query string on our login/signup pages). This avoids
 * open-redirect vulnerabilities and prevents redirecting users to
 * non-page routes (e.g. fetcher endpoints) that would render blank.
 * @param {string} path The redirect destination
 * @param {string} defaultRedirect The redirect to use if the to is unsafe.
 */
export function sanitizeRedirectPath(
  path: string | undefined | null,
  defaultRedirect: string = DEFAULT_REDIRECT
): string {
  if (!path || typeof path !== "string") {
    return defaultRedirect;
  }

  if (!path.startsWith("/") || path.startsWith("//")) {
    return defaultRedirect;
  }

  try {
    // should not parse as a full URL
    new URL(path);
    return defaultRedirect;
  } catch {}

  let parsed: URL;
  try {
    // ensure it's a valid relative path
    parsed = new URL(path, "https://example.com");
    if (parsed.hostname !== "example.com") {
      return defaultRedirect;
    }
  } catch {
    return defaultRedirect;
  }

  if (!isNavigablePath(parsed.pathname)) {
    return defaultRedirect;
  }

  return path;
}

export function titleCase(original: string): string {
  return original
    .split(" ")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export function appEnvTitleTag(appEnv?: string): string {
  if (!appEnv || appEnv === "production") {
    return "";
  }

  return ` (${appEnv})`;
}
