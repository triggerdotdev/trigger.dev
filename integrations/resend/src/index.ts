import type { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import { Resend as ResendClient } from "resend";

import type { AuthenticatedTask } from "@trigger.dev/sdk";

type SendEmailData = Parameters<
  InstanceType<typeof ResendClient>["sendEmail"]
>[0];

type SendEmailResponse = { id: string };

export const sendEmail: AuthenticatedTask<
  InstanceType<typeof ResendClient>,
  SendEmailData,
  SendEmailResponse
> = {
  run: async (params, client) => {
    return client.sendEmail(params) as Promise<SendEmailResponse>;
  },
  init: (params) => {
    const subjectProperty = params.subject
      ? [{ label: "Subject", text: params.subject }]
      : [];

    return {
      name: "Send Email",
      params,
      icon: "resend",
      properties: [
        {
          label: "From",
          text: params.from,
        },
        {
          label: "To",
          text: Array.isArray(params.to) ? params.to.join(", ") : params.to,
        },
        ...subjectProperty,
      ],
    };
  },
};

const tasks = {
  sendEmail,
};

export type ResendIntegrationOptions = {
  id: string;
  apiKey: string;
};

export class Resend
  implements TriggerIntegration<IntegrationClient<ResendClient, typeof tasks>>
{
  client: IntegrationClient<ResendClient, typeof tasks>;

  constructor(private options: ResendIntegrationOptions) {
    this.client = {
      tasks,
      usesLocalAuth: true,
      client: new ResendClient(options.apiKey),
      auth: {
        apiKey: options.apiKey,
      },
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "resend", name: "Resend.com" };
  }
}
