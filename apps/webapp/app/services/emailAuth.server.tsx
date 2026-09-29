import type { Authenticator } from "remix-auth";
import { EmailLinkStrategy } from "remix-auth-email-link";
import { env } from "~/env.server";
import { findOrCreateUser } from "~/models/user.server";
import { sendMagicLinkEmail } from "~/services/email.server";
import type { AuthUser } from "./authUser";
import { logger } from "./logger.server";

import { postAuthentication } from "./postAuth.server";
import { SsoRequiredError, ssoRedirectForEmail } from "./ssoAutoDiscovery.server";

let secret = env.MAGIC_LINK_SECRET;
if (!secret) throw new Error("Missing MAGIC_LINK_SECRET env variable.");

/**
 * The strategy's verify callback. It runs twice per login: once when SENDING
 * the link (`magicLinkVerify: false`, only to hand a user to `sendEmail`, which
 * ignores it; the throw is swallowed) and once when the link is opened.
 */
export async function verifyMagicLink({
  email,
  magicLinkVerify,
}: {
  email: string;
  magicLinkVerify: boolean;
}): Promise<AuthUser> {
  // Nothing may be created on the send path: an account must not exist for an
  // address until a link delivered to it has been opened, or anyone could
  // register someone else's email and have mail sent to it.
  if (!magicLinkVerify) {
    throw new Error("Magic link not yet verified");
  }

  logger.info("Magic link user authenticated");

  // Gate the link CLICK: a magic link issued before SSO enforcement flipped
  // on (or replayed within its validity window) must not mint a session for
  // an enforced domain.
  const ssoRedirect = await ssoRedirectForEmail(email, "domain_policy");
  if (ssoRedirect) {
    throw new SsoRequiredError(ssoRedirect);
  }

  try {
    const { user, isNewUser } = await findOrCreateUser({
      email,
      authenticationMethod: "MAGIC_LINK",
    });

    await postAuthentication({ user, isNewUser, loginMethod: "MAGIC_LINK" });

    return { userId: user.id };
  } catch (error) {
    logger.debug("Magic link user failed to authenticate", { error: JSON.stringify(error) });
    throw error;
  }
}

const emailStrategy = new EmailLinkStrategy(
  {
    sendEmail: sendMagicLinkEmail,
    secret,
    callbackURL: "/magic",
    sessionMagicLinkKey: "triggerdotdev:magiclink",
  },
  verifyMagicLink
);

export function addEmailLinkStrategy(authenticator: Authenticator<AuthUser>) {
  authenticator.use(emailStrategy);
}
