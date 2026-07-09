/**
 * Whether `request` is an unambiguously same-origin navigation, used to
 * CSRF-gate state-changing GET routes. `allowedOrigin` is the dashboard origin
 * (caller passes `env.LOGIN_ORIGIN`, kept out so the rule stays testable).
 *
 * Deny-by-default: prefer `Sec-Fetch-Site: same-origin` when present, otherwise
 * require a `Referer` whose origin matches `allowedOrigin`. Anything
 * missing/cross-site/unparseable returns `false`.
 */
export function isSameOriginNavigation(request: Request, allowedOrigin: string): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin";

  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === new URL(allowedOrigin).origin;
  } catch {
    return false;
  }
}
