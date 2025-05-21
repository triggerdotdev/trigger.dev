import type { DeliverEmail, SendPlainTextOptions } from "emails";
import { EmailClient, MailTransportOptions } from "emails";
import type { SendEmailOptions } from "remix-auth-email-link";
import { redirect } from "remix-typedjson";
import { env } from "~/env.server";
import type { AuthUser } from "./authUser";
import { workerQueue } from "./worker.server";
import { logger } from "./logger.server";
import { singleton } from "~/utils/singleton";
import { assertEmailAllowed } from "~/utils/email";

const client = singleton(
  "email-client",
  () =>
    new EmailClient({
      transport: buildTransportOptions(),
      imagesBaseUrl: env.APP_ORIGIN,
      from: env.FROM_EMAIL ?? "team@email.trigger.dev",
      replyTo: env.REPLY_TO_EMAIL ?? "help@email.trigger.dev",
    })
);

const alertsClient = singleton(
  "alerts-email-client",
  () =>
    new EmailClient({
      transport: buildTransportOptions(true),
      imagesBaseUrl: env.APP_ORIGIN,
      from: env.ALERT_FROM_EMAIL ?? "noreply@alerts.trigger.dev",
      replyTo: env.REPLY_TO_EMAIL ?? "help@email.trigger.dev",
    })
);

function buildTransportOptions(alerts?: boolean): MailTransportOptions {
  const transportType = alerts ? env.ALERT_EMAIL_TRANSPORT : env.EMAIL_TRANSPORT;
  logger.debug(
    `Constructing email transport '${transportType}' for usage '${alerts ? "alerts" : "general"}'`
  );

  switch (transportType) {
    case "aws-ses":
      return { type: "aws-ses" };
    case "resend":
      return {
        type: "resend",
        config: {
          apiKey: alerts ? env.ALERT_RESEND_API_KEY : env.RESEND_API_KEY,
        },
      };
    case "smtp":
      return {
        type: "smtp",
        config: {
          host: alerts ? env.ALERT_SMTP_HOST : env.SMTP_HOST,
          port: alerts ? env.ALERT_SMTP_PORT : env.SMTP_PORT,
          secure: alerts ? env.ALERT_SMTP_SECURE : env.SMTP_SECURE,
          auth: {
            user: alerts ? env.ALERT_SMTP_USER : env.SMTP_USER,
            pass: alerts ? env.ALERT_SMTP_PASSWORD : env.SMTP_PASSWORD,
          },
        },
      };
    default:
      return { type: undefined };
  }
}

export async function sendMagicLinkEmail(options: SendEmailOptions<AuthUser>): Promise<void> {
  assertEmailAllowed(options.emailAddress);

  // Auto redirect when in development mode
  if (env.NODE_ENV === "development") {
    throw redirect(options.magicLink);
  }

  logger.debug("Sending magic link email", { emailAddress: options.emailAddress });

  try {
    return await client.send({
      email: "magic_link",
      to: options.emailAddress,
      magicLink: options.magicLink,
    });
  } catch (error) {
    logger.error("Error sending magic link email", { error: JSON.stringify(error) });
    throw error;
  }
}

export async function sendPlainTextEmail(options: SendPlainTextOptions) {
  return client.sendPlainText(options);
}

export async function scheduleEmail(data: DeliverEmail, delay?: { seconds: number }) {
  const runAt = delay ? new Date(Date.now() + delay.seconds * 1000) : undefined;
  await workerQueue.enqueue("scheduleEmail", data, { runAt });
}

export async function sendEmail(data: DeliverEmail) {
  return client.send(data);
}

export async function sendAlertEmail(data: DeliverEmail) {
  return alertsClient.send(data);
}
