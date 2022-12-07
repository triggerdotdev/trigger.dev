import type { User } from "~/models/user.server";
import mailgun from "mailgun-js";
import { env } from "~/env.server";
import { mergent } from "./mergent.server";

const mailgunDomain = "apihero.run";

export const mailgunClient = mailgun({
  apiKey: env.MAILGUN_KEY,
  domain: mailgunDomain,
});

export async function sendEmail(
  emailAddress: string,
  subject: string,
  body: string
) {
  const data = {
    from: `Trigger.dev <${env.FROM_EMAIL}>`,
    to: emailAddress,
    subject,
    html: body,
  };

  await mailgunClient.messages().send(data);
}

export async function sendWelcomeEmail(user: User) {
  const data = {
    from: `Trigger.dev <${env.FROM_EMAIL}>`,
    to: user.email,
    subject: "🤝 Welcome to Trigger.dev!",
    template: "welcome_email_test1",
    "v:greeting": user.name ?? "there",
  };

  await mergent.tasks.create({
    request: {
      url: `${env.APP_ORIGIN}/webhooks/mailgun`,
      body: JSON.stringify(data),
      headers: {
        "Content-Type": "application/json",
      },
    },
    delay: { minutes: 30 },
  });
}
