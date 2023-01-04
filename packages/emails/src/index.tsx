import { ReactElement } from "react";
import WelcomeEmail from "../emails/welcome";
import MagicLinkEmail from "../emails/magic-link";
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
  ])
  .and(z.object({ to: z.string() }));

export type DeliverEmail = z.infer<typeof DeliverEmailSchema>;

export class EmailClient {
  #client: Resend;
  #from: string;
  #replyTo: string;

  constructor(apikey: string, from: string, replyTo: string) {
    this.#client = new Resend(apikey);
    this.#from = from;
    this.#replyTo = replyTo;
  }

  async send(data: DeliverEmail) {
    console.log("Send email", data);

    const { subject, component } = this.#getTemplate(data);
    return this.#sendEmail({
      to: data.to,
      subject,
      react: component,
    });
  }

  #getTemplate(data: DeliverEmail): {
    subject: string;
    component: ReactElement;
  } {
    switch (data.email) {
      case "welcome":
        return {
          subject: "🤝 Welcome to Trigger.dev!",
          component: <WelcomeEmail name={data.name} />,
        };
      case "magic_link":
        return {
          subject: "Magic sign-in link for Trigger.dev",
          component: <MagicLinkEmail magicLink={data.magicLink} />,
        };
    }
  }

  async #sendEmail({
    to,
    subject,
    react,
  }: {
    to: string;
    subject: string;
    react: ReactElement;
  }) {
    await this.#client.sendEmail({
      from: this.#from,
      to,
      replyTo: this.#replyTo,
      subject,
      react,
    });
  }
}
