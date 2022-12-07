import { renderToString } from "react-dom/server";
import type { SendEmailFunction } from "remix-auth-email-link";
import * as emailProvider from "~/services/email.server";
import { EmailLinkStrategy } from "remix-auth-email-link";
import type { Authenticator } from "remix-auth";
import type { AuthUser } from "./authUser";
import { findOrCreateUser } from "~/models/user.server";
import { env } from "~/env.server";

export const sendEmail: SendEmailFunction<AuthUser> = async (options) => {
  let subject = "Log in to API Hero";
  let body = renderToString(
    <div>
      <p>Hello,</p>
      <p>
        Click the link below to securely log in to API Hero. This link will
        expire in 15 minutes.
      </p>
      <br />
      <a href={options.magicLink}>Log in to API Hero</a>
      <br />
      <p>If you did not request this link, you can safely ignore this email.</p>
      <br />
      <p>Thanks,</p>
      <br />
      <p>The API Hero team</p>
    </div>
  );

  await emailProvider.sendEmail(options.emailAddress, subject, body);
};

let secret = env.MAGIC_LINK_SECRET;
if (!secret) throw new Error("Missing MAGIC_LINK_SECRET env variable.");

const emailStrategy = new EmailLinkStrategy(
  {
    sendEmail,
    secret,
    callbackURL: "/magic",
    sessionMagicLinkKey: "apihero:magiclink",
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
        //todo setup user with their first organisation and maybe a workflow too?
        // const firstWorkspace = await createFirstWorkspace(user.id);
        // await createFirstProject(user.id, firstWorkspace.id);
        await emailProvider.sendWelcomeEmail(user);
      }

      return { userId: user.id };
    } catch (error) {
      console.error(error);
      throw error;
    }
  }
);

export function addEmailLinkStrategy(authenticator: Authenticator<AuthUser>) {
  authenticator.use(emailStrategy);
}
