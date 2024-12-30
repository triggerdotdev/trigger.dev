import { EmailError, MailMessage, MailTransport, PlainTextMailMessage } from "./index";
import { Resend } from "resend";

export type ResendMailTransportOptions = {
  type: 'resend',
  config: {
    apiKey?: string
  }
}

export class ResendMailTransport implements MailTransport {
  #client: Resend;

  constructor(options: ResendMailTransportOptions) {
    this.#client = new Resend(options.config.apiKey)
  }

  async send({to, from, replyTo, subject, react}: MailMessage): Promise<void> {
    const result = await this.#client.emails.send({
      from: from,
      to,
      reply_to: replyTo,
      subject,
      react,
    });

    if (result.error) {
      console.error(
        `Failed to send email to ${to}, ${subject}. Error ${result.error.name}: ${result.error.message}`
      );
      throw new EmailError(result.error);
    }
  }

  async sendPlainText({to, from, replyTo, subject, text}: PlainTextMailMessage): Promise<void> {
    const result = await this.#client.emails.send({
      from: from,
      to,
      reply_to: replyTo,
      subject,
      text,
    });

    if (result.error) {
      console.error(
        `Failed to send email to ${to}, ${subject}. Error ${result.error.name}: ${result.error.message}`
      );
      throw new EmailError(result.error);
    }
  }
}
