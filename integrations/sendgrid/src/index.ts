import { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import sgMail from "@sendgrid/mail";

import type { AuthenticatedTask } from "@trigger.dev/sdk";

type SendEmailData = Parameters<(typeof sgMail)["send"]>[0];
type SendEmailResponse = [sgMail.ClientResponse, {}];

export const sendEmail: AuthenticatedTask<typeof sgMail, SendEmailData, SendEmailResponse> = {
  run: async (params, client) => {
    const response = await client.send(params);
    return response as SendEmailResponse;
  },
  init: (params) => {
    const subjectProperty = Array.isArray(params)
      ? []
      : params.subject
      ? [{ label: "Subject", text: params.subject }]
      : [];

    return {
      name: "Send Email",
      params,
      icon: "sendgrid",
      properties: [
        {
          label: "From",
          text: Array.isArray(params)
            ? getEmailFromEmailData(params[0].from)
            : getEmailFromEmailData(params.from),
        },
        {
          label: "To",
          text: Array.isArray(params)
            ? getEmailFromEmailData(params[0]?.to)
            : getEmailFromEmailData(params?.to),
        },
        ...subjectProperty,
      ],
      retry: {
        limit: 8,
        factor: 1.8,
        minTimeoutInMs: 500,
        maxTimeoutInMs: 30000,
        randomize: true,
      },
    };
  },
};

export const tasks = {
  sendEmail,
};

export type SendGridIntegrationOptions = {
  id: string;
  apiKey: string;
};

export class SendGrid
  implements TriggerIntegration<IntegrationClient<typeof sgMail, typeof tasks>>
{
  client: IntegrationClient<typeof sgMail, typeof tasks>;

  constructor(private options: SendGridIntegrationOptions) {
    if (!options.apiKey) {
      throw new Error(`Can't create SendGrid integration (${options.id}) as apiKey was undefined`);
    }

    sgMail.setApiKey(options.apiKey);

    this.client = {
      tasks,
      usesLocalAuth: true,
      client: sgMail,
      auth: {
        apiKey: options.apiKey,
      },
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "sendgrid", name: "SendGrid" };
  }
}

type EmailData = string | { name?: string; email: string };
type EmailDataArray = EmailData | EmailData[];

function getEmailFromEmailData(emailData: EmailDataArray | undefined): string {
  if (emailData === undefined) {
    return "";
  }
  if (Array.isArray(emailData)) {
    return emailData.map(getEmailFromEmailData).join(", ");
  }

  if (typeof emailData === "string") {
    return emailData;
  }
  return emailData.email;
}
