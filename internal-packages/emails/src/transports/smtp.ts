import { render } from "@react-email/render";
import { EmailError, MailMessage, MailTransport, PlainTextMailMessage } from "./index";
import nodemailer from "nodemailer"

export type SmtpMailTransportOptions = {
  type: 'smtp',
  config: {
    host?: string,
    port?: number,
    secure?: boolean,
    auth?: {
      user?: string,
      password?: string
    }
  }
}

export class SmtpMailTransport implements MailTransport {
  #client: nodemailer.Transporter;

  constructor(options: SmtpMailTransportOptions) {
    this.#client = nodemailer.createTransport(options.config)
  }

  async send({to, from, replyTo, subject, react}: MailMessage): Promise<void> {
    try {
      await this.#client.sendMail({
        from: from,
        to,
        replyTo: replyTo,
        subject,
        html: render(react),
      });
    }
    catch (error: Error) {
      console.error(
        `Failed to send email to ${to}, ${subject}. Error ${error.name}: ${error.message}`
      );
      throw new EmailError(error);
    }
  }

  async sendPlainText({to, from, replyTo, subject, text}: PlainTextMailMessage): Promise<void> {
    try {
      await this.#client.sendMail({
        from: from,
        to,
        replyTo: replyTo,
        subject,
        text: text,
      });
    }
    catch (error: Error) {
      console.error(
        `Failed to send email to ${to}, ${subject}. Error ${error.name}: ${error.message}`
      );
      throw new EmailError(error);
    }
  }
}
