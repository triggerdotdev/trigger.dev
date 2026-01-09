import type { LoaderFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { prisma } from "~/db.server";
import { getSession, redirectWithErrorMessage } from "~/models/message.server";
import { authenticator } from "~/services/auth.server";
import { setLastAuthMethodHeader } from "~/services/lastAuthMethod.server";
import { commitSession } from "~/services/sessionStorage.server";
import { getReferralSource, clearReferralSourceCookie } from "~/services/referralSource.server";
import { telemetry } from "~/services/telemetry.server";
import { redirectCookie } from "./auth.google";
import { sanitizeRedirectPath } from "~/utils";

export let loader: LoaderFunction = async ({ request }) => {
  const cookie = request.headers.get("Cookie");
  const redirectValue = await redirectCookie.parse(cookie);
  const redirectTo = sanitizeRedirectPath(redirectValue);

  const auth = await authenticator.authenticate("google", request, {
    failureRedirect: "/login", // If auth fails, the failureRedirect will be thrown as a Response
  });

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

  // and store the user data
  session.set(authenticator.sessionKey, auth);

  const headers = new Headers();
  headers.append("Set-Cookie", await commitSession(session));
  headers.append("Set-Cookie", await setLastAuthMethodHeader("google"));

  // Read referral source cookie and set in PostHog if present (only for new users), then clear it
  const referralSource = await getReferralSource(request);
  if (referralSource) {
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
    });
    if (user) {
      // Only set referralSource for new users (created within the last 30 seconds)
      const userAge = Date.now() - user.createdAt.getTime();
      const isNewUser = userAge < 30 * 1000; // 30 seconds
      
      if (isNewUser) {
        telemetry.user.identify({
          user,
          isNewUser: true,
          referralSource,
        });
      }
    }
    // Clear the cookie after using it (regardless of whether we set it)
    headers.append("Set-Cookie", await clearReferralSourceCookie());
  }

  return redirect(redirectTo, { headers });
};

