import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { authenticator } from "~/services/auth.server";
import { MfaRequiredError } from "~/services/mfa/multiFactorAuthentication.server";
import { getRedirectTo } from "~/services/redirectTo.server";
import { getUserSession, commitSession } from "~/services/sessionStorage.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    // Attempt to authenticate the user with email-link
    const authUser = await authenticator.authenticate("email-link", request, {
      successRedirect: undefined, // Don't auto-redirect, we'll handle it
      failureRedirect: undefined, // Don't auto-redirect on failure either
    });

    // If we get here, user doesn't have MFA - complete login normally
    const redirectTo = await getRedirectTo(request);
    return redirect(redirectTo ?? "/");
  } catch (error) {
    // Check if this is an MFA_REQUIRED error
    if (error instanceof MfaRequiredError) {
      // User has MFA enabled - store pending user ID and redirect to MFA page
      const session = await getUserSession(request);
      session.set("pending-mfa-user-id", error.userId);

      const redirectTo = await getRedirectTo(request);
      session.set("pending-mfa-redirect-to", redirectTo ?? "/");

      return redirect("/login/mfa", {
        headers: {
          "Set-Cookie": await commitSession(session),
        },
      });
    }

    // Regular authentication failure, redirect to magic link page
    return redirect("/login/magic");
  }
}
