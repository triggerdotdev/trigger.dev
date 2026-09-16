import { sanitizeRedirectPath } from "~/utils";

function isVercelHostname(hostname: string): boolean {
  return hostname === "vercel.com" || hostname.endsWith(".vercel.com");
}

export function sanitizeGitHubSettingsRedirect(
  redirectUrl: string | undefined,
  applicationOrigin: string
): string | undefined {
  if (!redirectUrl) {
    return undefined;
  }

  if (redirectUrl.startsWith("/")) {
    const sanitized = sanitizeRedirectPath(redirectUrl, "");
    return sanitized || undefined;
  }

  let destination: URL;
  let trustedOrigin: string;
  try {
    destination = new URL(redirectUrl);
    trustedOrigin = new URL(applicationOrigin).origin;
  } catch {
    return undefined;
  }

  if (destination.username || destination.password) {
    return undefined;
  }

  if (destination.origin === trustedOrigin) {
    const relativeUrl = `${destination.pathname}${destination.search}${destination.hash}`;
    const sanitized = sanitizeRedirectPath(relativeUrl, "");
    return sanitized || undefined;
  }

  if (
    destination.protocol === "https:" &&
    !destination.port &&
    isVercelHostname(destination.hostname.toLowerCase())
  ) {
    return destination.toString();
  }

  return undefined;
}
