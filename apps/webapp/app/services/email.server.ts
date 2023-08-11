import type { DeliverEmail } from "emails";
import { EmailClient } from "emails";
import type { SendEmailOptions } from "remix-auth-email-link";
import { redirect } from "remix-typedjson";
import { env } from "~/env.server";
import type { User } from "~/models/user.server";
import type { AuthUser } from "./authUser";
import { workerQueue } from "./worker.server";

const client = new EmailClient({
  smtpConfig: {
    host:env.SMTP_HOST,
    secure: true,
    port: env.SMTP_PORT,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASSWORD,
    },
  }, 
  imagesBaseUrl: env.APP_ORIGIN,
  from: env.FROM_EMAIL ?? "team@email.trigger.dev",
  replyTo: env.REPLY_TO_EMAIL ?? "help@email.trigger.dev",
});

export async function sendMagicLinkEmail(options: SendEmailOptions<AuthUser>): Promise<void> {
  // Auto redirect when in development mode
  if (env.NODE_ENV === "development") {
    throw redirect(options.magicLink);
  }

  return client.send({
    email: "magic_link",
    to: options.emailAddress,
    magicLink: options.magicLink,
  });
}

export async function scheduleWelcomeEmail(user: User) {
  //delay for one minute in development, longer in production
  const delay = process.env.NODE_ENV === "development" ? 1000 * 60 : 1000 * 60 * 22;

  await workerQueue.enqueue(
    "scheduleEmail",
    {
      email: "welcome",
      to: user.email,
      name: user.name ?? undefined,
    },
    { runAt: new Date(Date.now() + delay) }
  );
}

export async function scheduleEmail(data: DeliverEmail, delay?: { seconds: number }) {
  const runAt = delay ? new Date(Date.now() + delay.seconds * 1000) : undefined;
  await workerQueue.enqueue("scheduleEmail", data, { runAt });
}

export async function sendEmail(data: DeliverEmail) {
  return client.send(data);
}
