import type { LoaderFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { prisma } from "~/db.server";
import { getSession, redirectWithErrorMessage } from "~/models/message.server";
import { authenticator } from "~/services/auth.server";
import { setLastAuthMethodHeader } from "~/services/lastAuthMethod.server";
import { commitSession } from "~/services/sessionStorage.server";
import { trackAndClearReferralSource } from "~/services/referralSource.server";
import { redirectCookie } from "./auth.github";
import { sanitizeRedirectPath } from "~/utils";

export let loader: LoaderFunction = async ({ request }) => {
  const cookie = request.headers.get("Cookie");
  const redirectValue = await redirectCookie.parse(cookie);
  const redirectTo = sanitizeRedirectPath(redirectValue);

  const auth = await authenticator.authenticate("github", request, {
    failureRedirect: "/login", // If auth fails, the failureRedirect will be thrown as a Response
  });

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
    headers.append("Set-Cookie", await setLastAuthMethodHeader("github"));

    return redirect("/login/mfa", { headers });
  }

  session.set(authenticator.sessionKey, auth);

  const headers = new Headers();
  headers.append("Set-Cookie", await commitSession(session));
  headers.append("Set-Cookie", await setLastAuthMethodHeader("github"));

  await trackAndClearReferralSource(request, auth.userId, headers);

  return redirect(redirectTo, { headers });
};
