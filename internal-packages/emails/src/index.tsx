import { render } from "@react-email/render";
import { ReactElement } from "react";
import AlertRunFailureEmail, { AlertRunEmailSchema } from "../emails/alert-run-failure";
import AlertAttemptFailureEmail, { AlertAttemptEmailSchema } from "../emails/alert-attempt-failure";
import { setGlobalBasePath } from "../emails/components/BasePath";
import AlertDeploymentFailureEmail, {
  AlertDeploymentFailureEmailSchema,
} from "../emails/deployment-failure";
import AlertDeploymentSuccessEmail, {
  AlertDeploymentSuccessEmailSchema,
} from "../emails/deployment-success";
import InviteEmail, { InviteEmailSchema } from "../emails/invite";
import MagicLinkEmail from "../emails/magic-link";
import WelcomeEmail from "../emails/welcome";

import { Resend } from "resend";
import { z } from "zod";

export const DeliverEmailSchema = z
  .discriminatedUnion("email", [
    z.object({
      email: z.literal("welcome"),
      name: z.string().optional(),
    }),
    z.object({
      email: z.literal("magic_link"),
      magicLink: z.string().url(),
    }),
    InviteEmailSchema,
    AlertRunEmailSchema,
    AlertAttemptEmailSchema,
    AlertDeploymentFailureEmailSchema,
    AlertDeploymentSuccessEmailSchema,
  ])
  .and(z.object({ to: z.string() }));

export type DeliverEmail = z.infer<typeof DeliverEmailSchema>;

export type SendPlainTextOptions = { to: string; subject: string; text: string };

export class EmailClient {
  #client?: Resend;
  #imagesBaseUrl: string;
  #from: string;
  #replyTo: string;

  constructor(config: { apikey?: string; imagesBaseUrl: string; from: string; replyTo: string }) {
    this.#client =
      config.apikey && config.apikey.startsWith("re_") ? new Resend(config.apikey) : undefined;
    this.#imagesBaseUrl = config.imagesBaseUrl;
    this.#from = config.from;
    this.#replyTo = config.replyTo;
  }

  async send(data: DeliverEmail) {
    const { subject, component } = this.#getTemplate(data);

    setGlobalBasePath(this.#imagesBaseUrl);

    return this.#sendEmail({
      to: data.to,
      subject,
      react: component,
    });
  }

  async sendPlainText(options: SendPlainTextOptions) {
    if (this.#client) {
      await this.#client.emails.send({
        from: this.#from,
        to: options.to,
        reply_to: this.#replyTo,
        subject: options.subject,
        text: options.text,
      });

      return;
    }
  }

  #getTemplate(data: DeliverEmail): {
    subject: string;
    component: ReactElement;
  } {
    switch (data.email) {
      case "welcome":
        return {
          subject: "✨ Welcome to Trigger.dev!",
          component: <WelcomeEmail name={data.name} />,
        };
      case "magic_link":
        return {
          subject: "Magic sign-in link for Trigger.dev",
          component: <MagicLinkEmail magicLink={data.magicLink} />,
        };
      case "invite":
        return {
          subject: `You've been invited to join ${data.orgName} on Trigger.dev`,
          component: <InviteEmail {...data} />,
        };
      case "alert-attempt": {
        return {
          subject: `[${data.organization}] Error on ${data.taskIdentifier} [${data.version}.${data.environment}] ${data.error.message}`,
          component: <AlertAttemptFailureEmail {...data} />,
        };
      }
      case "alert-run": {
        return {
          subject: `[${data.organization}] Run ${data.runId} failed for ${data.taskIdentifier} [${data.version}.${data.environment}] ${data.error.message}`,
          component: <AlertRunFailureEmail {...data} />,
        };
      }
      case "alert-deployment-failure": {
        return {
          subject: `[${data.organization}] Deployment ${data.version} [${data.environment}] failed: ${data.error.name}`,
          component: <AlertDeploymentFailureEmail {...data} />,
        };
      }
      case "alert-deployment-success": {
        return {
          subject: `[${data.organization}] Deployment ${data.version} [${data.environment}] succeeded`,
          component: <AlertDeploymentSuccessEmail {...data} />,
        };
      }
    }
  }

  async #sendEmail({ to, subject, react }: { to: string; subject: string; react: ReactElement }) {
    if (this.#client) {
      const result = await this.#client.emails.send({
        from: this.#from,
        to,
        reply_to: this.#replyTo,
        subject,
        react,
      });

      if (result.error) {
        console.error(
          `Failed to send email to ${to}, ${subject}. Error ${result.error.name}: ${result.error.message}`
        );
        throw new EmailError(result.error);
      }

      return;
    }

    console.log(`
##### sendEmail to ${to}, subject: ${subject}

${render(react, {
  plainText: true,
})}
    `);
  }
}

//EmailError type where you can set the name and message
export class EmailError extends Error {
  constructor({ name, message }: { name: string; message: string }) {
    super(message);
    this.name = name;
  }
}
