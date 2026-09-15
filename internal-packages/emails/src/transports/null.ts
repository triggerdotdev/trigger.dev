import { render } from "@react-email/render";
import type { MailMessage, MailTransport, PlainTextMailMessage } from "./index";

export type NullMailTransportOptions = {
  type: undefined;
};

export class NullMailTransport implements MailTransport {
  constructor(options: NullMailTransportOptions) {}

  async send({ to, subject, react }: MailMessage): Promise<void> {
    const plainText = await render(react, {
      plainText: true,
    });

    console.log(`
##### sendEmail to ${to}, subject: ${subject}

${plainText}
    `);
  }

  async sendPlainText({ to, subject, text }: PlainTextMailMessage): Promise<void> {
    console.log(`
##### sendEmail to ${to}, subject: ${subject}

${text}
    `);
  }
}
