import * as emailProvider from "~/services/email.server";
import { EmailLinkStrategy } from "remix-auth-email-link";
import type { Authenticator } from "remix-auth";
import type { AuthUser } from "./authUser";
import { findOrCreateUser } from "~/models/user.server";
import { env } from "~/env.server";
import { createFirstOrganization } from "~/models/organization.server";
import { sendMagicLinkEmail } from "~/services/email.server";
import { taskQueue } from "./messageBroker.server";

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

      if (isNewUser) {
        await createFirstOrganization(user);
        await emailProvider.scheduleWelcomeEmail(user);

        await taskQueue.publish("SEND_INTERNAL_EVENT", {
          id: user.id,
          name: "user.created",
          payload: {
            id: user.id,
            source: "MAGIC_LINK",
            admin: user.admin,
          },
        });
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
