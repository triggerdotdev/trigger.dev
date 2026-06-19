import type { LoaderFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { authenticator } from "~/services/auth.server";
import { setLastAuthMethodHeader } from "~/services/lastAuthMethod.server";
import { commitSession, getUserSession } from "~/services/sessionStorage.server";
import { commitAuthenticatedSession } from "~/services/sessionDuration.server";
import { trackAndClearReferralSource } from "~/services/referralSource.server";
import { appendRedirectTo, ssoRedirectFromAuthError } from "~/services/ssoAutoDiscovery.server";
import type { AuthUser } from "~/services/authUser";
import { redirectCookie } from "./auth.github";
import { sanitizeRedirectPath } from "~/utils";

export let loader: LoaderFunction = async ({ request }) => {
  const cookie = request.headers.get("Cookie");
  const redirectValue = await redirectCookie.parse(cookie);
  const redirectTo = sanitizeRedirectPath(redirectValue);

  // The SSO auto-discovery gate runs inside the strategy's verify
  // callback (before any account write), so an SSO-enforced domain
  // throws out here instead of linking the GitHub identity. remix-auth
  // surfaces its own OAuth redirects by throwing Responses — pass those
  // through; an SsoRequiredError becomes the SSO redirect.
  let auth: AuthUser;
  try {
    // throwOnError so a verify-callback throw surfaces as an
    // AuthorizationError (carrying the SsoRequiredError as `cause`)
    // rather than being flattened into a bare 401 Response — otherwise
    // the SSO-enforced redirect below is never reached.
    auth = await authenticator.authenticate("github", request, { throwOnError: true });
  } catch (thrown) {
    if (thrown instanceof Response) throw thrown;
    const ssoRedirect = ssoRedirectFromAuthError(thrown);
    if (ssoRedirect) {
      return redirect(appendRedirectTo(ssoRedirect, redirectTo));
    }
    // Without `failureRedirect`, remix-auth no longer flashes the verify error
    // onto the session before throwing — so flash it here under the same
    // `auth:error` key the /login loader reads. Otherwise an allow-list
    // rejection or provider error silently re-renders the login form with no
    // indication of what went wrong.
    const session = await getUserSession(request);
    session.flash("auth:error", {
      message: thrown instanceof Error ? thrown.message : "Failed to sign in with GitHub.",
    });
    return redirect("/login", {
      headers: { "Set-Cookie": await commitSession(session) },
    });
  }

  const session = await getUserSession(request);

  const userRecord = await prisma.user.findFirst({
    where: {
      id: auth.userId,
    },
    select: {
      id: true,
      mfaEnabledAt: true,
    },
  });

  if (!userRecord) {
    return redirectWithErrorMessage(
      "/login",
      request,
      "Could not find your account. Please contact support."
    );
  }

  if (userRecord.mfaEnabledAt) {
    session.set("pending-mfa-user-id", userRecord.id);
    session.set("pending-mfa-redirect-to", redirectTo);
    // Clear any `pending-sso` left over from an aborted SSO login in the same
    // browser session — otherwise `completeLogin` would stamp an SSO marker
    // onto this GitHub session and `revalidateSsoSession` would later validate
    // it against an IdP the user never authenticated through.
    session.unset("pending-sso");

    const headers = new Headers();
    headers.append("Set-Cookie", await commitSession(session));
    headers.append("Set-Cookie", await setLastAuthMethodHeader("github"));

    return redirect("/login/mfa", { headers });
  }

  session.set(authenticator.sessionKey, auth);

  const headers = new Headers();
  headers.append("Set-Cookie", await commitAuthenticatedSession(session, auth.userId));
  headers.append("Set-Cookie", await setLastAuthMethodHeader("github"));

  await trackAndClearReferralSource(request, auth.userId, headers);

  return redirect(redirectTo, { headers });
};
