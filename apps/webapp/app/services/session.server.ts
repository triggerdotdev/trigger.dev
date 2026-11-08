import { redirect } from "@remix-run/node";
import { prisma, type PrismaClientOrTransaction } from "~/db.server";
import { getUserById } from "~/models/user.server";
import { sanitizeRedirectPath } from "~/utils";
import { extractClientIp } from "~/utils/extractClientIp.server";
import { authenticator } from "./auth.server";
import {
  getImpersonationId,
  getImpersonationState,
  getSupportAccessDenial,
} from "./impersonation.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { type SupportAccessDecision } from "~/utils/impersonationState";
import { checkSession } from "./accessPolicy.server";
import { logger } from "./logger.server";
import { SESSION_ISSUED_AT_KEY } from "./sessionDuration.server";
import { getUserSession } from "./sessionStorage.server";
import { revalidateSsoSession } from "./ssoSessionRevalidation.server";

/**
 * Logs the user out when their session has lived past `User.nextSessionEnd`.
 *
 * The deadline is written at login (and any time the effective duration is
 * recomputed — see `commitAuthenticatedSession`) and shortened in bulk when
 * an admin lowers an org cap (see the admin `session-duration` route).
 * `getUserId` enforces it on every authenticated request, including
 * `requireUserId`-only routes and single-route data requests, so a session past
 * its deadline can't keep calling actions (such as minting a personal access
 * token) without a page navigation. Impersonation paths enforce against the
 * admin's deadline, so a `requireUserId`-only route can't keep operating as the
 * impersonation target after the admin's session has expired or their admin
 * role was revoked.
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
export async function maybeAutoLogout(
  request: Request,
  user: { id: string; nextSessionEnd: Date | null },
  impersonatedUserId: string | null = null
): Promise<void> {
  if (user.nextSessionEnd === null) return;
  if (Date.now() <= user.nextSessionEnd.getTime()) return;
  // Don't redirect to /logout when we're already on /logout — root.tsx's
  // loader runs for every route (including /logout itself), so without this
  // guard an expired session would redirect to /logout in a loop and the
  // route's own loader (which destroys the session cookie) would never run.
  if (new URL(request.url).pathname === "/logout") return;

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
  return endSession(request);
}

// Pages outside a Support Access session go back to its org; data requests get a 403.
// Never-allowed pages get a 403 too, since the session's org can redirect to them.
async function supportAccessDenialResponse(
  request: Request,
  denial: Extract<SupportAccessDecision, { type: "deny" }>
) {
  const url = new URL(request.url);
  const isResourceRequest = /^\/(?:resources|api)\//i.test(url.pathname);
  const isPageNavigation =
    request.method === "GET" && !(isResourceRequest && url.searchParams.has("_data"));
  if (!isPageNavigation || denial.reason === "never_allowed") {
    return new Response("Outside this Support Access session", { status: 403 });
  }
  const { homeSlug } = denial;
  if (!homeSlug) return redirect("/@");
  if (url.pathname === "/") return redirect(`/orgs/${homeSlug}`);
  return redirectWithErrorMessage(
    `/orgs/${homeSlug}`,
    request,
    "That page is outside this Support Access session."
  );
}

/**
 * The admin's own user id while they impersonate someone, otherwise undefined. The
 * impersonation cookie holds the target's id; this reads the signed-in admin instead.
 */
export async function getImpersonatorUserId(request: Request): Promise<string | undefined> {
  if (!(await getImpersonationId(request))) return undefined;
  const authUser = await authenticator.isAuthenticated(request);
  return authUser?.userId;
}

export async function getUserId(request: Request): Promise<string | undefined> {
  const impersonatedUserId = await getImpersonationId(request);

  if (!impersonatedUserId) {
    const denial = await getSupportAccessDenial(request);
    if (denial) {
      const authUser = await authenticator.isAuthenticated(request);
      const realUser = authUser?.userId ? await getUserById(authUser.userId) : null;
      if (realUser?.admin) throw await supportAccessDenialResponse(request, denial);
    }
  }

  if (impersonatedUserId) {
    // Impersonating: verify the real user (the admin) is still an admin and
    // enforce against their deadline (the cap belongs to the cookie, not the
    // target). If admin status was revoked, fall through to operate as the
    // admin themselves — otherwise a `requireUserId`-only route would keep
    // letting them act as the impersonation target after losing the role.
    const authUser = await authenticator.isAuthenticated(request);
    if (!authUser?.userId) return undefined;
    // The real user's session is checked whether or not they are still an admin.
    await enforceSessionPolicy(request, authUser.userId);
    const realUser = await getUserById(authUser.userId);
    if (!realUser) return authUser.userId;
    if (realUser.admin) {
      await maybeAutoLogout(request, realUser, impersonatedUserId);
      return impersonatedUserId;
    }
    await maybeAutoLogout(request, realUser);
    return authUser.userId;
  }

  const authUser = await authenticator.isAuthenticated(request);
  // SSO session re-validation runs here so it covers both navigation
  // (getUser) and API fetches (requireUserId). It's single-flight and
  // throttled, so most requests do nothing; only SSO-marked sessions
  // touch Redis. Throws redirect("/logout") if the IdP says invalid.
  await revalidateSsoSession(request, authUser);
  if (authUser?.userId) {
    const decision = await enforceSessionPolicy(request, authUser.userId);
    // The plugin can return the deadline from its own read, saving one query per request.
    const user =
      decision.nextSessionEnd !== undefined
        ? { nextSessionEnd: decision.nextSessionEnd }
        : await getSessionAuthState(prisma, authUser.userId);
    if (user) await maybeAutoLogout(request, { id: authUser.userId, ...user });
  }
  return authUser?.userId;
}

export type SessionAuthState = { nextSessionEnd: Date | null };

/** Reads a user's session deadline. Runs on every authenticated request. */
export async function getSessionAuthState(
  client: PrismaClientOrTransaction,
  userId: string
): Promise<SessionAuthState | null> {
  return client.user.findFirst({ where: { id: userId }, select: { nextSessionEnd: true } });
}

/** Ends the session when the access policy plugin no longer accepts it. */
async function enforceSessionPolicy(
  request: Request,
  userId: string
): Promise<{ nextSessionEnd?: Date | null }> {
  if (new URL(request.url).pathname === "/logout") return {};
  const session = await getUserSession(request);
  const issuedAt = session.get(SESSION_ISSUED_AT_KEY);
  const decision = await checkSession({
    userId,
    issuedAt: typeof issuedAt === "number" ? issuedAt : undefined,
  });
  if (decision.valid) return decision;
  logger.warn("Session ended by access policy", {
    event: "auth.session_refused",
    userId,
    requestPath: new URL(request.url).pathname,
  });
  return endSession(request);
}

export async function getUser(request: Request) {
  const userId = await getUserId(request);
  if (userId === undefined) return null;
  const user = await getUserById(userId);
  if (!user) {
    // Same loop-guard as in maybeAutoLogout: if /logout's loader is what
    // matched, let it destroy the cookie itself rather than redirecting in
    // circles via root.tsx.
    if (new URL(request.url).pathname === "/logout") return null;
    return endSession(request);
  }
  // Auto-logout for the non-impersonation path. The impersonation path was
  // already enforced inside `getUserId` against the admin's deadline, so
  // skip re-checking against the (impersonation target's) row here.
  const impersonationId = await getImpersonationId(request);
  if (!impersonationId) await maybeAutoLogout(request, user);
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

  // Shared with the root loader so the client never reads a different answer
  // than the one computed here.
  const { isImpersonating, isViewingAsUser } = await getImpersonationState(request, user.id);
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
    isImpersonating,
    isViewingAsUser,
  };
}

/**
 * Whether admin-only UI should be rendered for this user.
 *
 * Display only. The "view as user" toggle is cosmetic and must never widen or
 * narrow a real security boundary — authorization stays on `user.admin`, the
 * route builder's `authorization` block and the per-feature access checks.
 *
 * The rule: the toggle changes what is *shown*, never what is *permitted or
 * what happens*. "Shown" is narrow — rendering and read-only listings. A badge,
 * a debug tooltip, an extra table column, a control that is merely hidden while
 * the handler behind it re-checks the raw flags: all fine.
 *
 * It does NOT extend to a value a request handler reads, nor to the option set
 * of a control that submits. An option list feeding a mutation is not display:
 * shrinking it changes what a submitted form is able to do, and where the
 * current value is not among the remaining options it can change which value
 * the form carries. Those stay on raw `user.admin || user.isImpersonating`, or
 * the admin's own submissions start behaving differently — or failing — the
 * moment they flip the toggle on.
 */
export function hasAdminDisplayAccess(user: {
  admin: boolean;
  isImpersonating: boolean;
  isViewingAsUser: boolean;
}): boolean {
  return (user.admin || user.isImpersonating) && !user.isViewingAsUser;
}

/**
 * Ends the session in this response: clears the cookie and redirects home. Server-side logouts
 * must not go through GET /logout, which refuses navigations that are not same-origin (a typed
 * URL or bookmark) without clearing the cookie, so the browser would loop.
 */
async function endSession(request: Request): Promise<never> {
  return authenticator.logout(request, { redirectTo: "/" });
}
