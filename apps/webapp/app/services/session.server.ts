import { redirect } from "@remix-run/node";
import { getUserById } from "~/models/user.server";
import { authenticator } from "./auth.server";
import { getImpersonationId } from "./impersonation.server";

export async function getUserId(request: Request): Promise<string | undefined> {
  const impersonatedUserId = await getImpersonationId(request);

  if (impersonatedUserId) return impersonatedUserId;

  let authUser = await authenticator.isAuthenticated(request);
  return authUser?.userId;
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
    const searchParams = new URLSearchParams([
      ["redirectTo", redirectTo ?? `${url.pathname}${url.search}`],
    ]);
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
      isImpersonating: !!impersonationId,
    };
  }

  throw await logout(request);
}

export async function logout(request: Request) {
  return redirect("/logout");
}
