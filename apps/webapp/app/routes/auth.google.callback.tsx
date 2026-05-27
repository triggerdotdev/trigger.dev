import type { LoaderFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { authenticator } from "~/services/auth.server";
import { setLastAuthMethodHeader } from "~/services/lastAuthMethod.server";
import { commitSession, getUserSession } from "~/services/sessionStorage.server";
import { commitAuthenticatedSession } from "~/services/sessionDuration.server";
import { trackAndClearReferralSource } from "~/services/referralSource.server";
import { ssoRedirectFromAuthError } from "~/services/ssoAutoDiscovery.server";
import type { AuthUser } from "~/services/authUser";
import { redirectCookie } from "./auth.google";
import { sanitizeRedirectPath } from "~/utils";

export let loader: LoaderFunction = async ({ request }) => {
  const cookie = request.headers.get("Cookie");
  const redirectValue = await redirectCookie.parse(cookie);
  const redirectTo = sanitizeRedirectPath(redirectValue);

  // The SSO auto-discovery gate runs inside the strategy's verify
  // callback (before any account write), so an SSO-enforced domain
  // throws out here instead of linking the Google identity. remix-auth
  // surfaces its own OAuth redirects by throwing Responses — pass those
  // through; an SsoRequiredError becomes the SSO redirect.
  let auth: AuthUser;
  try {
    // throwOnError so a verify-callback throw surfaces as an
    // AuthorizationError (carrying the SsoRequiredError as `cause`)
    // rather than being flattened into a bare 401 Response — otherwise
    // the SSO-enforced redirect below is never reached.
    auth = await authenticator.authenticate("google", request, { throwOnError: true });
  } catch (thrown) {
    if (thrown instanceof Response) throw thrown;
    const ssoRedirect = ssoRedirectFromAuthError(thrown);
    if (ssoRedirect) {
      return redirect(ssoRedirect);
    }
    return redirect("/login");
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

    const headers = new Headers();
    headers.append("Set-Cookie", await commitSession(session));
    headers.append("Set-Cookie", await setLastAuthMethodHeader("google"));

    return redirect("/login/mfa", { headers });
  }

  session.set(authenticator.sessionKey, auth);

  const headers = new Headers();
  headers.append("Set-Cookie", await commitAuthenticatedSession(session, auth.userId));
  headers.append("Set-Cookie", await setLastAuthMethodHeader("google"));

  await trackAndClearReferralSource(request, auth.userId, headers);

  return redirect(redirectTo, { headers });
};

