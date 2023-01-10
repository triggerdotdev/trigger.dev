import * as emailProvider from "~/services/email.server";
import { EmailLinkStrategy } from "remix-auth-email-link";
import type { Authenticator } from "remix-auth";
import type { AuthUser } from "./authUser";
import { findOrCreateUser } from "~/models/user.server";
import { env } from "~/env.server";
import { createFirstOrganization } from "~/models/organization.server";
import { sendMagicLinkEmail } from "~/services/email.server";

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
    try {
      const { user, isNewUser } = await findOrCreateUser({
        email,
        authenticationMethod: "MAGIC_LINK",
      });

      console.log(
        `User ${user.id} logged in with magic link. ${
          isNewUser ? "New user." : ""
        }`
      );

      if (isNewUser) {
        await createFirstOrganization(user);
        emailProvider.scheduleWelcomeEmail(user);
      }

      return { userId: user.id };
    } catch (error) {
      throw error;
    }
  }
);

export function addEmailLinkStrategy(authenticator: Authenticator<AuthUser>) {
  authenticator.use(emailStrategy);
}
