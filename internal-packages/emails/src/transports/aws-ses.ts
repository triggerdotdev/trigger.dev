import { render } from "@react-email/render";
import { EmailError, MailMessage, MailTransport, PlainTextMailMessage } from "./index";
import nodemailer from "nodemailer";
import * as awsSes from "@aws-sdk/client-ses";

export type AwsSesMailTransportOptions = {
  type: "aws-ses";
};

export class AwsSesMailTransport implements MailTransport {
  #client: nodemailer.Transporter;

  constructor(options: AwsSesMailTransportOptions) {
    const ses = new awsSes.SESClient();

    this.#client = nodemailer.createTransport({
      SES: {
        aws: awsSes,
        ses,
      },
    });
  }

  async send({ to, from, replyTo, subject, react }: MailMessage): Promise<void> {
    try {
      await this.#client.sendMail({
        from: from,
        to,
        replyTo: replyTo,
        subject,
        html: await render(react),
      });
    } catch (error) {
      if (error instanceof Error) {
        console.error(
          `Failed to send email to ${to}, ${subject}. Error ${error.name}: ${error.message}`
        );
        throw new EmailError(error);
      } else {
        throw error;
      }
    }
  }

  async sendPlainText({ to, from, replyTo, subject, text }: PlainTextMailMessage): Promise<void> {
    try {
      await this.#client.sendMail({
        from: from,
        to,
        replyTo: replyTo,
        subject,
        text: text,
      });
    } catch (error) {
      if (error instanceof Error) {
        console.error(
          `Failed to send email to ${to}, ${subject}. Error ${error.name}: ${error.message}`
        );
        throw new EmailError(error);
      } else {
        throw error;
      }
    }
  }
}
