import { ReactElement } from "react";

import { z } from "zod";
import AlertAttemptFailureEmail, { AlertAttemptEmailSchema } from "../emails/alert-attempt-failure";
import AlertRunFailureEmail, { AlertRunEmailSchema } from "../emails/alert-run-failure";
import { setGlobalBasePath } from "../emails/components/BasePath";
import AlertDeploymentFailureEmail, {
  AlertDeploymentFailureEmailSchema,
} from "../emails/deployment-failure";
import AlertDeploymentSuccessEmail, {
  AlertDeploymentSuccessEmailSchema,
} from "../emails/deployment-success";
import InviteEmail, { InviteEmailSchema } from "../emails/invite";
import MagicLinkEmail from "../emails/magic-link";

import { constructMailTransport, MailTransport, MailTransportOptions } from "./transports";
import MfaEnabledEmail, { MfaEnabledEmailSchema } from "../emails/mfa-enabled";
import MfaDisabledEmail, { MfaDisabledEmailSchema } from "../emails/mfa-disabled";

export { type MailTransportOptions };

export const DeliverEmailSchema = z
  .discriminatedUnion("email", [
    z.object({
      email: z.literal("magic_link"),
      magicLink: z.string().url(),
    }),
    InviteEmailSchema,
    AlertRunEmailSchema,
    AlertAttemptEmailSchema,
    AlertDeploymentFailureEmailSchema,
    AlertDeploymentSuccessEmailSchema,
    MfaEnabledEmailSchema,
    MfaDisabledEmailSchema,
  ])
  .and(z.object({ to: z.string() }));

export type DeliverEmail = z.infer<typeof DeliverEmailSchema>;

export type SendPlainTextOptions = { to: string; subject: string; text: string };

export class EmailClient {
  #transport: MailTransport;

  #imagesBaseUrl: string;
  #from: string;
  #replyTo: string;

  constructor(config: {
    transport?: MailTransportOptions;
    imagesBaseUrl: string;
    from: string;
    replyTo: string;
  }) {
    this.#transport = constructMailTransport(config.transport ?? { type: undefined });

    this.#imagesBaseUrl = config.imagesBaseUrl;
    this.#from = config.from;
    this.#replyTo = config.replyTo;
  }

  async send(data: DeliverEmail) {
    const { subject, component } = this.#getTemplate(data);

    setGlobalBasePath(this.#imagesBaseUrl);

    return await this.#transport.send({
      to: data.to,
      subject,
      react: component,
      from: this.#from,
      replyTo: this.#replyTo,
    });
  }

  async sendPlainText(options: SendPlainTextOptions) {
    await this.#transport.sendPlainText({
      ...options,
      from: this.#from,
      replyTo: this.#replyTo,
    });
  }

  #getTemplate(data: DeliverEmail): {
    subject: string;
    component: ReactElement;
  } {
    switch (data.email) {
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
          subject: `[${data.organization}] Run ${data.runId} failed for ${data.taskIdentifier} [${
            data.version
          }.${data.environment}] ${formatErrorMessageForSubject(data.error.message)}`,
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
      case "mfa-enabled": {
        return {
          subject: `Multi-factor authentication enabled on your Trigger.dev account`,
          component: <MfaEnabledEmail {...data} />,
        };
      }
      case "mfa-disabled": {
        return {
          subject: `Multi-factor authentication disabled on your Trigger.dev account`,
          component: <MfaDisabledEmail {...data} />,
        };
      }
    }
  }
}

function formatErrorMessageForSubject(message?: string) {
  if (!message) {
    return "";
  }

  const singleLine = message.replace(/[\r\n]+/g, " ");
  return singleLine.length > 30 ? singleLine.substring(0, 27) + "..." : singleLine;
}
