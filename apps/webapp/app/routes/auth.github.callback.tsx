import type { LoaderFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticator } from "~/services/auth.server";
import { redirectCookie } from "./auth.github";
import { getUserSession, commitSession } from "~/services/sessionStorage.server";
import { logger } from "~/services/logger.server";
import { MfaRequiredError } from "~/services/mfa/multiFactorAuthentication.server";

export let loader: LoaderFunction = async ({ request }) => {
  try {
    const cookie = request.headers.get("Cookie");
    const redirectValue = await redirectCookie.parse(cookie);
    const redirectTo = redirectValue ?? "/";

    logger.debug("auth.github.callback loader", {
      redirectTo,
    });

    const authuser = await authenticator.authenticate("github", request, {
      successRedirect: undefined, // Don't auto-redirect, we'll handle it
      failureRedirect: undefined, // Don't auto-redirect on failure either
    });

    logger.debug("auth.github.callback authuser", {
      authuser,
    });

    // If we get here, user doesn't have MFA - complete login normally
    return redirect(redirectTo);
  } catch (error) {
    // Check if this is an MFA_REQUIRED error
    if (error instanceof MfaRequiredError) {
      // User has MFA enabled - store pending user ID and redirect to MFA page
      const session = await getUserSession(request);
      session.set("pending-mfa-user-id", error.userId);

      const cookie = request.headers.get("Cookie");
      const redirectValue = await redirectCookie.parse(cookie);
      const redirectTo = redirectValue ?? "/";
      session.set("pending-mfa-redirect-to", redirectTo);

      return redirect("/login/mfa", {
        headers: {
          "Set-Cookie": await commitSession(session),
        },
      });
    }

    // Regular authentication failure, redirect to login page
    logger.debug("auth.github.callback error", { error });
    return redirect("/login");
  }
};
