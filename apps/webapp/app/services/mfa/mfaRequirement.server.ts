import { redirect } from "@remix-run/node";
import { env } from "~/env.server";
import { sanitizeRedirectPath } from "~/utils";
import { mfaSetupPath } from "~/utils/pathBuilder";

// Paths a signed-in user may reach while MFA is still required of them. The
// setup page itself, the whole auth flow (any deeper and a user who has not
// enrolled cannot log in at all, and `/login/mfa` must stay reachable for
// users who HAVE enrolled), logout, and the MFA setup fetcher endpoint — which
// is the only way to enroll, so gating it would deadlock the flow.
//
// `/logout` matters for the same loop reason as in `maybeAutoLogout`: the root
// loader runs for `/logout` itself, so an unconditional redirect here would
// prevent the session cookie ever being destroyed.
const MFA_SETUP_EXACT_PATHS = new Set(["/magic", "/logout", "/login", "/mfa/setup"]);
const MFA_SETUP_PREFIXES = ["/login/", "/auth/", "/resources/account/mfa/setup"];

/** True when `pathname` is reachable without having enrolled MFA yet. */
export function isMfaExemptPath(pathname: string): boolean {
  if (MFA_SETUP_EXACT_PATHS.has(pathname)) return true;
  return MFA_SETUP_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

/**
 * The second half of the `MFA_REQUIRED` gate: given a user who is missing a
 * second factor, decide whether this request may proceed anyway.
 *
 * Returns a redirect to the MFA setup page, or `null` when the request is
 * allowed (either because the flag is off, the user has enrolled, or the path
 * is on the exemption list above).
 *
 * Callers are expected to `throw` the returned response — the same convention
 * `requireUser` uses for its login redirect.
 */
export function mfaRequirementRedirect(
  request: Request,
  user: { mfaEnabledAt: Date | null } | null
): Response | null {
  // Logged-out requests are handled by the normal login flow; they can only
  // reach the exempt paths above anyway, but check the flag first so the
  // common case costs a single boolean read.
  if (!env.MFA_REQUIRED || !user || user.mfaEnabledAt) return null;

  const url = new URL(request.url);
  if (isMfaExemptPath(url.pathname)) return null;

  // Carry the destination across the forced detour so the user lands where
  // they were headed once enrollment completes. Sanitized: this is a
  // user-influenced URL (the query string of the blocked request).
  const redirectTo = sanitizeRedirectPath(`${url.pathname}${url.search}`);
  const searchParams = new URLSearchParams([["redirectTo", redirectTo]]);
  return redirect(`${mfaSetupPath()}?${searchParams}`);
}

/**
 * Throwing variant for use inside auth helpers: aborts the request with the
 * setup redirect when `MFA_REQUIRED` is on and the user has not enrolled.
 * A no-op for every other case.
 */
export function throwIfMfaRequired(
  request: Request,
  user: { mfaEnabledAt: Date | null } | null
): void {
  const redirectResponse = mfaRequirementRedirect(request, user);
  if (redirectResponse) throw redirectResponse;
}
