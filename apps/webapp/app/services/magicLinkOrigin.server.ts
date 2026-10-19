/**
 * Makes an email-link strategy build every magic link on `origin`.
 *
 * `remix-auth-email-link` builds the link from the request's `X-Forwarded-Host`
 * (falling back to `Host`). Both are client-controlled, so a request for someone
 * else's address could make us email them a genuine link pointing at another
 * host, which would then receive the token. Links must only ever point at our
 * login origin.
 *
 * The library keeps `getDomainURL` private, so this replaces it on the instance.
 * It throws if the method is gone, so a library upgrade that renames it fails at
 * boot instead of silently reverting to header-derived links.
 */
export function pinMagicLinkOrigin(strategy: object, origin: string): void {
  if (typeof (strategy as { getDomainURL?: unknown }).getDomainURL !== "function") {
    throw new Error(
      "remix-auth-email-link no longer builds magic links with getDomainURL; update pinMagicLinkOrigin"
    );
  }

  const pinnedOrigin = new URL(origin).origin;
  Object.defineProperty(strategy, "getDomainURL", {
    value: () => pinnedOrigin,
    configurable: true,
    writable: true,
  });
}
