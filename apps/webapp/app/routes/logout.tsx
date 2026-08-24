import { redirect, type ActionFunction, type LoaderFunction } from "@remix-run/node";
import { env } from "~/env.server";
import { authenticator } from "~/services/auth.server";
import { sanitizeRedirectPath } from "~/utils";
import { isSameOriginNavigation } from "~/utils/sameOriginNavigation";
import { SSO_SESSION_EXPIRED_REASON } from "~/utils/ssoSession";

function logoutRedirectTo(request: Request): string {
  const url = new URL(request.url);
  // Trusted internal constant — bypasses sanitizeRedirectPath, which rejects
  // /login as a navigable target.
  if (url.searchParams.get("reason") === SSO_SESSION_EXPIRED_REASON) {
    return `/login?reason=${SSO_SESSION_EXPIRED_REASON}`;
  }
  return sanitizeRedirectPath(url.searchParams.get("redirectTo"), "/");
}

export const action: ActionFunction = async ({ request }) => {
  return await authenticator.logout(request, { redirectTo: logoutRedirectTo(request) });
};

export const loader: LoaderFunction = async ({ request }) => {
  // GET /logout is state-changing, so reject cross-site navigations.
  if (!isSameOriginNavigation(request, env.LOGIN_ORIGIN)) {
    throw redirect("/");
  }

  return await authenticator.logout(request, { redirectTo: logoutRedirectTo(request) });
};
