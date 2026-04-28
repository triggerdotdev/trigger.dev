import { redirect } from "@remix-run/node";
import { getUserById } from "~/models/user.server";
import { sanitizeRedirectPath } from "~/utils";
import { authenticator } from "./auth.server";
import { getImpersonationId } from "./impersonation.server";
import { getEffectiveSessionDuration, isSessionExpired } from "./sessionDuration.server";
import { getUserSession } from "./sessionStorage.server";

export async function getUserId(request: Request): Promise<string | undefined> {
  const impersonatedUserId = await getImpersonationId(request);

  if (impersonatedUserId) {
    // Verify the real user (from the session cookie) is still an admin
    const authUser = await authenticator.isAuthenticated(request);
    if (authUser?.userId) {
      const realUser = await getUserById(authUser.userId);
      if (realUser?.admin) {
        return impersonatedUserId;
      }
    }
    // Admin revoked or session invalid — fall through to return the real user's ID
    return authUser?.userId;
  }

  const authUser = await authenticator.isAuthenticated(request);
  if (!authUser?.userId) return undefined;

  // Enforce the user's effective session duration (User.sessionDuration capped
  // by the most restrictive Organization.maxSessionDuration). If the session
  // was issued longer ago than the cap allows, force a logout.
  const session = await getUserSession(request);
  const { durationSeconds } = await getEffectiveSessionDuration(authUser.userId);
  if (isSessionExpired(session, durationSeconds)) {
    throw await logout(request);
  }

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
