/**
 * Makes an email-link strategy build every magic link on a configured origin.
 *
 * `remix-auth-email-link` otherwise builds the link from the request's
 * `X-Forwarded-Host` (falling back to `Host`). Both are client-controlled, so
 * a request for someone else's address could make us email them a genuine link
 * pointing at another host. The resolver below only selects an exact configured
 * origin and ignores forwarded host/protocol headers.
 *
 * The library keeps `getDomainURL` private, so this replaces it on the
 * instance. It throws if the method is gone, so a library upgrade that renames
 * it fails at boot instead of silently reverting to header-derived links.
 */
export function pinMagicLinkOrigin(
  strategy: object,
  origin: string | ((request: Request) => string)
): void {
  if (typeof (strategy as { getDomainURL?: unknown }).getDomainURL !== "function") {
    throw new Error(
      "remix-auth-email-link no longer builds magic links with getDomainURL; update pinMagicLinkOrigin"
    );
  }

  const getOrigin = typeof origin === "function" ? origin : () => origin;
  Object.defineProperty(strategy, "getDomainURL", {
    value: (request: Request) => new URL(getOrigin(request)).origin,
    configurable: true,
    writable: true,
  });
}
