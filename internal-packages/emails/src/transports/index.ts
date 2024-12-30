import { ReactElement } from "react";
import { AwsSesMailTransport, AwsSesMailTransportOptions } from "./aws-ses";
import { NullMailTransport, NullMailTransportOptions } from "./null";
import { ResendMailTransport, ResendMailTransportOptions } from "./resend";
import { SmtpMailTransport, SmtpMailTransportOptions } from "./smtp";

export type MailMessage = {
  to: string;
  from: string;
  replyTo: string;
  subject: string;
  react: ReactElement;
};

export type PlainTextMailMessage = {
  to: string;
  from: string;
  replyTo: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
  sendPlainText(message: PlainTextMailMessage): Promise<void>;
}

export class EmailError extends Error {
  constructor({ name, message }: { name: string; message: string }) {
    super(message);
    this.name = name;
  }
}

export type MailTransportOptions =
  AwsSesMailTransportOptions |
  ResendMailTransportOptions |
  NullMailTransportOptions |
  SmtpMailTransportOptions

export function constructMailTransport(options: MailTransportOptions): MailTransport {
  switch(options.type) {
    case "aws-ses":
      return new AwsSesMailTransport(options);
    case "resend":
      return new ResendMailTransport(options);
    case "smtp":
      return new SmtpMailTransport(options);
    case undefined:
      return new NullMailTransport(options);
  }
}
