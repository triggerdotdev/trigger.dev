import type { Authenticator } from "remix-auth";
import { EmailLinkStrategy } from "remix-auth-email-link";
import { env } from "~/env.server";
import { findOrCreateUser } from "~/models/user.server";
import { sendMagicLinkEmail } from "~/services/email.server";
import type { AuthUser } from "./authUser";
import { logger } from "./logger.server";

import { postAuthentication } from "./postAuth.server";

let secret = env.MAGIC_LINK_SECRET;
if (!secret) throw new Error("Missing MAGIC_LINK_SECRET env variable.");

const emailStrategy = new EmailLinkStrategy(
  {
    sendEmail: sendMagicLinkEmail,
    secret,
    callbackURL: "/magic",
    sessionMagicLinkKey: "triggerdotdev:magiclink",
  },
  async ({
    email,
    form,
    magicLinkVerify,
  }: {
    email: string;
    form: FormData;
    magicLinkVerify: boolean;
  }) => {
    logger.info("Magic link user authenticated", { email, magicLinkVerify });

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
);

export function addEmailLinkStrategy(authenticator: Authenticator<AuthUser>) {
  authenticator.use(emailStrategy);
}
