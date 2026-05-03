import { redirect } from "@remix-run/node";
import { getUserById } from "~/models/user.server";
import { sanitizeRedirectPath } from "~/utils";
import { extractClientIp } from "~/utils/extractClientIp.server";
import { authenticator } from "./auth.server";
import { getImpersonationId } from "./impersonation.server";
import { logger } from "./logger.server";

/**
 * Logs the user out when their session has lived past `User.nextSessionEnd`.
 *
 * The deadline is written at login (and any time the effective duration is
 * recomputed — see `commitAuthenticatedSession`) and shortened in bulk when
 * an admin lowers an org cap (see the admin `session-duration` route).
 * Reading here is a free piggyback on the User row that `requireUser`/
 * `getUser` already fetches — there is no per-request DB query added by this
 * check. `requireUserId`/`getUserId` deliberately do NOT enforce: enforcement
 * happens at the next page navigation (root.tsx loader calls `getUser`),
 * which matches HIPAA auto-logoff semantics — terminate sessions at the
 * navigation boundary, not on every polling fetch.
 *
 * `nextSessionEnd === null` means "no enforced deadline" — applies to legacy
 * sessions from before this feature shipped. The default `User.sessionDuration`
 * is 1 year (matching the cookie's `Max-Age`), so a null deadline is
 * functionally identical to "natural cookie expiry" for users with default
 * settings. Every path that produces a sub-default effective duration —
 * fresh login, user setting change, admin cap change — also writes
 * `nextSessionEnd`, so there is no realistic state where an unenforced null
 * masks a tighter cap.
 */
function maybeAutoLogout(
  request: Request,
  user: { id: string; nextSessionEnd: Date | null },
  impersonatedUserId: string | null = null
): void {
  if (user.nextSessionEnd === null) return;
  if (Date.now() <= user.nextSessionEnd.getTime()) return;

  // HIPAA audit trail: structured log lands in CloudWatch via stdout. Use
  // the stable `event` field to filter/aggregate auto-logout events.
  // `sourceIp` uses ALB's appended (last) X-Forwarded-For element, not the
  // first one, since the leading element is client-supplied and spoofable.
  logger.info("Auto-logout: session exceeded effective duration", {
    event: "session.auto_logout",
    userId: user.id,
    impersonatedUserId,
    nextSessionEnd: user.nextSessionEnd.toISOString(),
    requestPath: new URL(request.url).pathname,
    sourceIp: extractClientIp(request.headers.get("x-forwarded-for")),
  });
  throw redirect("/logout");
}

export async function getUserId(request: Request): Promise<string | undefined> {
  // Cookie-only fast path: zero DB queries. Impersonation admin-verification
  // and auto-logout enforcement happen in `getUser`/`requireUser`, where we
  // already pay for a User row fetch.
  const impersonatedUserId = await getImpersonationId(request);
  if (impersonatedUserId) return impersonatedUserId;

  const authUser = await authenticator.isAuthenticated(request);
  return authUser?.userId;
}

export async function getUser(request: Request) {
  const impersonatedUserId = await getImpersonationId(request);
  const authUser = await authenticator.isAuthenticated(request);

  if (impersonatedUserId && authUser?.userId) {
    // Impersonating: verify the real user is still an admin and enforce the
    // *admin's* deadline (the cap belongs to the cookie, not the
    // impersonation target). If the admin is no longer admin, fall back to
    // operating as the admin themselves — same defense-in-depth as before.
    const realUser = await getUserById(authUser.userId);
    if (!realUser) throw await logout(request);
    if (realUser.admin) {
      maybeAutoLogout(request, realUser, impersonatedUserId);
      const target = await getUserById(impersonatedUserId);
      if (!target) throw await logout(request);
      return target;
    }
    maybeAutoLogout(request, realUser);
    return realUser;
  }

  if (!authUser?.userId) return null;
  const user = await getUserById(authUser.userId);
  if (!user) throw await logout(request);
  maybeAutoLogout(request, user);
  return user;
}

export async function requireUserId(request: Request, redirectTo?: string) {
  const userId = await getUserId(request);
  if (!userId) {
    const url = new URL(request.url);
    // Only propagate the originating URL when it's a real user-navigable page.
    // Fetcher endpoints (e.g. /resources/*) and auth callbacks would render
    // blank or loop if used as a post-login destination.
    const finalRedirectTo = sanitizeRedirectPath(redirectTo ?? `${url.pathname}${url.search}`);
    const searchParams = new URLSearchParams([["redirectTo", finalRedirectTo]]);
    throw redirect(`/login?${searchParams}`);
  }
  return userId;
}

export type UserFromSession = Awaited<ReturnType<typeof requireUser>>;

export async function requireUser(request: Request) {
  const user = await getUser(request);
  if (!user) {
    const url = new URL(request.url);
    const finalRedirectTo = sanitizeRedirectPath(`${url.pathname}${url.search}`);
    const searchParams = new URLSearchParams([["redirectTo", finalRedirectTo]]);
    throw redirect(`/login?${searchParams}`);
  }

  const impersonationId = await getImpersonationId(request);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    admin: user.admin,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    dashboardPreferences: user.dashboardPreferences,
    confirmedBasicDetails: user.confirmedBasicDetails,
    mfaEnabledAt: user.mfaEnabledAt,
    isImpersonating: !!impersonationId && impersonationId === user.id,
  };
}

export async function logout(request: Request) {
  return redirect("/logout");
}
