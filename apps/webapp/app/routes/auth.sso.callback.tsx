import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import type { SsoFlow, SsoProfile } from "@trigger.dev/plugins";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { authenticator } from "~/services/auth.server";
import { setLastAuthMethodHeader } from "~/services/lastAuthMethod.server";
import { logger } from "~/services/logger.server";
import { ssoController } from "~/services/sso.server";
import { commitAuthenticatedSession } from "~/services/sessionDuration.server";
import { commitSession, getUserSession } from "~/services/sessionStorage.server";

// Resolve the SSO completion for either the SP-initiated (state present)
// or IdP-initiated (no state) flow. Throws a redirect to the error page
// on failure, letting the caller stay on the happy path. Returning a
// single shape here is what lets the loader use a plain destructure
// rather than three conditionally-assigned `let`s.
async function resolveSsoCompletion(
  code: string,
  state: string | null
): Promise<{ profile: SsoProfile; redirectTo: string; flow: SsoFlow }> {
  if (state) {
    const completion = await ssoController.completeAuthorization({ code, state });
    if (completion.isErr()) {
      logger.warn("SSO callback failed", { reason: completion.error, idpInitiated: false });
      throw redirect(`/login/sso?error=sso_failed`);
    }
    return completion.value;
  }

  const completion = await ssoController.completeIdpInitiatedAuthorization({ code });
  if (completion.isErr()) {
    logger.warn("SSO callback failed", { reason: completion.error, idpInitiated: true });
    throw redirect(`/login/sso?error=sso_failed`);
  }
  return { ...completion.value, flow: "idp_initiated" };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) {
    return redirect(`/login/sso?error=missing_code`);
  }
  const state = url.searchParams.get("state");

  const { profile, redirectTo, flow } = await resolveSsoCompletion(code, state);

  const auth = await authenticator.authenticate("sso", request, {
    throwOnError: true,
    context: { profile, flow },
  });

  const session = await getUserSession(request);

  const userRecord = await prisma.user.findFirst({
    where: { id: auth.userId },
    select: { id: true, mfaEnabledAt: true },
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
    // Carry the SSO marker through the MFA hop so the final session is
    // revalidated against the IdP exactly like a non-MFA SSO session.
    session.set("pending-sso", {
      idpOrgId: profile.idpOrgId,
      connectionId: profile.idpConnectionId,
    });

    const headers = new Headers();
    headers.append("Set-Cookie", await commitSession(session));
    headers.append("Set-Cookie", await setLastAuthMethodHeader("sso"));
    return redirect("/login/mfa", { headers });
  }

  // Mark the session as SSO-established so the periodic re-validation
  // hook knows to check it against the IdP. The marker is signed into
  // the cookie (tamper-proof).
  session.set(authenticator.sessionKey, {
    ...auth,
    sso: { idpOrgId: profile.idpOrgId, connectionId: profile.idpConnectionId },
  });

  const headers = new Headers();
  headers.append("Set-Cookie", await commitAuthenticatedSession(session, auth.userId));
  headers.append("Set-Cookie", await setLastAuthMethodHeader("sso"));

  return redirect(redirectTo, { headers });
}
