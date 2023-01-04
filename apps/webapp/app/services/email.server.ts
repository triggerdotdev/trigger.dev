import { EmailClient } from "emails";
import type { SendEmailOptions } from "remix-auth-email-link";
import { env } from "~/env.server";
import type { User } from "~/models/user.server";
import type { AuthUser } from "./authUser";

const client = new EmailClient(
  env.RESEND_API_KEY,
  env.FROM_EMAIL,
  env.REPLY_TO_EMAIL
);

export async function sendMagicLinkEmail(
  options: SendEmailOptions<AuthUser>
): Promise<void> {
  return client.send({
    email: "magic_link",
    to: options.emailAddress,
    magicLink: options.magicLink,
  });
}

export async function sendWelcomeEmail(user: User) {
  try {
    await client.send({
      email: "welcome",
      to: user.email,
      name: user.name ?? undefined,
    });
  } catch (e) {
    console.error("Welcome email failed to send", e);
  }
}
