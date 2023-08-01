import { ReactElement } from "react";
import { BasePath } from "../emails/components/BasePath";
import WelcomeEmail from "../emails/welcome";
import MagicLinkEmail from "../emails/magic-link";
import ConnectIntegration from "../emails/connect-integration";
import WorkflowFailed from "../emails/workflow-failed";
import WorkflowIntegration from "../emails/workflow-integration";
import InviteEmail, { InviteEmailSchema } from "../emails/invite";
import { render } from "@react-email/render";

import { Resend } from "resend";
import { z } from "zod";
import React from "react";

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
    z.object({
      email: z.literal("connect_integration"),
      workflowId: z.string(),
      integration: z.string(),
    }),
    z.object({
      email: z.literal("workflow_failed"),
      workflowId: z.string(),
    }),
    z.object({
      email: z.literal("workflow_integration"),
      workflowId: z.string(),
      integration: z.string(),
    }),
  ])
  .and(z.object({ to: z.string() }));

export type DeliverEmail = z.infer<typeof DeliverEmailSchema>;

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

    return this.#sendEmail({
      to: data.to,
      subject,
      react: <BasePath basePath={this.#imagesBaseUrl}>{component}</BasePath>,
    });
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
      case "connect_integration":
        return {
          subject: `Action required: you need to connect to ${data.integration}`,
          component: (
            <ConnectIntegration workflowId={data.workflowId} integration={data.integration} />
          ),
        };
      case "workflow_failed":
        return {
          subject: "Action required: your workflow has stopped running!",
          component: <WorkflowFailed workflowId={data.workflowId} />,
        };
      case "workflow_integration":
        return {
          subject: `Action required: connect ${data.integration} to start your workflow`,
          component: (
            <WorkflowIntegration workflowId={data.workflowId} integration={data.integration} />
          ),
        };
    }
  }

  async #sendEmail({ to, subject, react }: { to: string; subject: string; react: ReactElement }) {
    if (this.#client) {
      await this.#client.sendEmail({
        from: this.#from,
        to,
        replyTo: this.#replyTo,
        subject,
        react,
      });

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
