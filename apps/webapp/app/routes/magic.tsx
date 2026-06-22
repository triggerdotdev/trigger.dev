import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { authenticator } from "~/services/auth.server";
import { setLastAuthMethodHeader } from "~/services/lastAuthMethod.server";
import { getRedirectTo } from "~/services/redirectTo.server";
import { commitSession, getSession } from "~/services/sessionStorage.server";
import { commitAuthenticatedSession } from "~/services/sessionDuration.server";
import { trackAndClearReferralSource } from "~/services/referralSource.server";
import { appendRedirectTo, ssoRedirectFromAuthError } from "~/services/ssoAutoDiscovery.server";
import type { AuthUser } from "~/services/authUser";
import { sanitizeRedirectPath } from "~/utils";

export async function loader({ request }: LoaderFunctionArgs) {
  // Defense-in-depth: sanitize the cookie value to drop non-page paths in case
  // a stale cookie from before sanitization shipped is still in the browser.
  const sanitized = sanitizeRedirectPath(await getRedirectTo(request));
  const redirectTo = sanitized === "/" ? undefined : sanitized;

  // The magic-link verify callback runs the SSO gate before any account
  // write, so an SSO-enforced domain throws out here. remix-auth's own
  // redirects are thrown Responses — pass those through.
  let auth: AuthUser;
  try {
    auth = await authenticator.authenticate("email-link", request);
  } catch (thrown) {
    if (thrown instanceof Response) throw thrown;
    const ssoRedirect = ssoRedirectFromAuthError(thrown);
    if (ssoRedirect) {
      return redirect(appendRedirectTo(ssoRedirect, redirectTo));
    }
    // Without `failureRedirect`, remix-auth no longer flashes the verify
    // error onto the session before throwing — so flash it here under the
    // same `auth:error` key the /login/magic loader reads. Otherwise an
    // expired/invalid link silently re-renders the email form with no
    // indication of what went wrong.
    const session = await getSession(request.headers.get("cookie"));
    session.flash("auth:error", {
      message:
        thrown instanceof Error
          ? thrown.message
          : "Your magic link is invalid or has expired.",
    });
    return redirect("/login/magic", {
      headers: { "Set-Cookie": await commitSession(session) },
    });
  }

  // manually get the session
  const session = await getSession(request.headers.get("cookie"));

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
      "/login/magic",
      request,
      "Could not find your account. Please contact support."
    );
  }

  if (userRecord.mfaEnabledAt) {
    session.set("pending-mfa-user-id", userRecord.id);
    session.set("pending-mfa-redirect-to", redirectTo ?? "/");
    // Clear any `pending-sso` left over from an aborted SSO login in the same
    // browser session — otherwise `completeLogin` would stamp an SSO marker
    // onto this magic-link session and `revalidateSsoSession` would later
    // validate it against an IdP the user never authenticated through.
    session.unset("pending-sso");

    const headers = new Headers();
    headers.append("Set-Cookie", await commitSession(session));
    headers.append("Set-Cookie", await setLastAuthMethodHeader("email"));

    return redirect("/login/mfa", { headers });
  }

  // and store the user data
  session.set(authenticator.sessionKey, auth);

  const headers = new Headers();
  headers.append("Set-Cookie", await commitAuthenticatedSession(session, auth.userId));
  headers.append("Set-Cookie", await setLastAuthMethodHeader("email"));

  await trackAndClearReferralSource(request, auth.userId, headers);

  return redirect(redirectTo ?? "/", { headers });
}
