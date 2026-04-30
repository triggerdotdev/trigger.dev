import { redirect } from "@remix-run/node";
import { $replica } from "~/db.server";
import { getUserById } from "~/models/user.server";
import { sanitizeRedirectPath } from "~/utils";
import { extractClientIp } from "~/utils/extractClientIp.server";
import { authenticator } from "./auth.server";
import { getImpersonationId } from "./impersonation.server";
import { logger } from "./logger.server";
import {
  getEffectiveSessionDuration,
  getSessionIssuedAt,
  isSessionExpired,
} from "./sessionDuration.server";
import { getUserSession } from "./sessionStorage.server";

/**
 * Enforces the user's effective session duration (User.sessionDuration capped
 * by the most restrictive Organization.maxSessionDuration). If the session was
 * issued longer ago than the cap allows, throws a redirect to `/logout` and
 * emits a HIPAA audit log. `userId` is always the *session owner's* id (i.e.
 * the real authenticated user), not an impersonated one — because the cap
 * belongs to the cookie, not the impersonation target.
 */
async function enforceSessionExpiry(
  request: Request,
  userId: string,
  impersonatedUserId: string | null = null
): Promise<void> {
  const session = await getUserSession(request);
  // Hot path: every authenticated request runs this. Read from the replica
  // when one is configured (falls back to primary). Stale-by-replica-lag is
  // acceptable here because the worst case is a session living a few seconds
  // past its cap on the very first request after a cap change.
  const { durationSeconds, orgCapSeconds, cappingOrgId, userSettingSeconds } =
    await getEffectiveSessionDuration(userId, $replica);
  if (!isSessionExpired(session, durationSeconds)) return;

  const issuedAt = getSessionIssuedAt(session);
  // HIPAA audit trail: structured log lands in CloudWatch via stdout. Use
  // the stable `event` field to filter/aggregate auto-logout events.
  // `sourceIp` uses ALB's appended (last) X-Forwarded-For element, not the
  // first one, since the leading element is client-supplied and spoofable.
  logger.info("Auto-logout: session exceeded effective duration", {
    event: "session.auto_logout",
    userId,
    impersonatedUserId,
    cappingOrgId,
    effectiveDurationSeconds: durationSeconds,
    userSettingSeconds,
    orgCapSeconds,
    sessionAgeMs: issuedAt === null ? null : Date.now() - issuedAt,
    requestPath: new URL(request.url).pathname,
    sourceIp: extractClientIp(request.headers.get("x-forwarded-for")),
  });
  throw redirect("/logout");
}

export async function getUserId(request: Request): Promise<string | undefined> {
  const impersonatedUserId = await getImpersonationId(request);

  if (impersonatedUserId) {
    // Verify the real user (from the session cookie) is still an admin
    const authUser = await authenticator.isAuthenticated(request);
    if (authUser?.userId) {
      const realUser = await getUserById(authUser.userId);
      if (realUser?.admin) {
        // Enforce expiry against the admin's own session — impersonation must
        // not be a way to bypass the admin's effective duration cap.
        await enforceSessionExpiry(request, authUser.userId, impersonatedUserId);
        return impersonatedUserId;
      }
    }
    // Admin revoked or session invalid — fall through to return the real
    // user's ID. Same enforcement as the regular auth path below.
    if (authUser?.userId) {
      await enforceSessionExpiry(request, authUser.userId);
    }
    return authUser?.userId;
  }

  const authUser = await authenticator.isAuthenticated(request);
  if (!authUser?.userId) return undefined;

  await enforceSessionExpiry(request, authUser.userId);
  return authUser.userId;
}

export async function getUser(request: Request) {
  const userId = await getUserId(request);
  if (userId === undefined) return null;

  const user = await getUserById(userId);
  if (user) return user;

  throw await logout(request);
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
  const userId = await requireUserId(request);

  const impersonationId = await getImpersonationId(request);
  const user = await getUserById(userId);
  if (user) {
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
      isImpersonating: !!impersonationId && impersonationId === userId,
    };
  }

  throw await logout(request);
}

export async function logout(request: Request) {
  return redirect("/logout");
}
