import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { authenticator } from "~/services/auth.server";
import { setLastAuthMethodHeader } from "~/services/lastAuthMethod.server";
import { getRedirectTo } from "~/services/redirectTo.server";
import { commitSession, getSession } from "~/services/sessionStorage.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const redirectTo = await getRedirectTo(request);

  const auth = await authenticator.authenticate("email-link", request, {
    failureRedirect: "/login/magic", // If auth fails, the failureRedirect will be thrown as a Response
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
      "/login/magic",
      request,
      "Could not find your account. Please contact support."
    );
  }

  if (userRecord.mfaEnabledAt) {
    session.set("pending-mfa-user-id", userRecord.id);
    session.set("pending-mfa-redirect-to", redirectTo ?? "/");

    const headers = new Headers();
    headers.append("Set-Cookie", await commitSession(session));
    headers.append("Set-Cookie", await setLastAuthMethodHeader("email"));

    return redirect("/login/mfa", { headers });
  }

  // and store the user data
  session.set(authenticator.sessionKey, auth);

  const headers = new Headers();
  headers.append("Set-Cookie", await commitSession(session));
  headers.append("Set-Cookie", await setLastAuthMethodHeader("email"));

  return redirect(redirectTo ?? "/", { headers });
}
