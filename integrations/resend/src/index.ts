import type { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import { Resend as ResendClient } from "resend";


import type { AuthenticatedTask } from "@trigger.dev/sdk";

type SendEmailData = Parameters<InstanceType<typeof ResendClient>["sendEmail"]>[0];

type SendEmailResponse = { id: string };

function isRequestError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error;
}

function onError(error: any) {
  if (!isRequestError(error)) {
    return;
  }

  // Check if this is a rate limit error
  if (error.status === 429 && error.response) {
    const rateLimitReset = error.response.headers["x-ratelimit-reset"];
    const rateLimitRemaining = error.response.headers["ratelimit-remaining"];

    if (rateLimitRemaining === "0" && rateLimitReset) {
      const resetDate = new Date(Number(rateLimitReset) * 1000);

      return {
        retryAt: resetDate,
        error,
      };
    }
  }
}

export const sendEmail: AuthenticatedTask<
  InstanceType<typeof ResendClient>,
  SendEmailData,
  SendEmailResponse
> = {
  onError,
  run: async (params, client) => {
    return client.sendEmail(params) as Promise<SendEmailResponse>;
  },
  init: (params) => {
    const subjectProperty = params.subject ? [{ label: "Subject", text: params.subject }] : [];

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

export class Resend implements TriggerIntegration<IntegrationClient<ResendClient, typeof tasks>> {
  client: IntegrationClient<ResendClient, typeof tasks>;

  constructor(private options: ResendIntegrationOptions) {
    if (Object.keys(options).includes("apiKey") && !options.apiKey) {
      throw `Can't create Resend integration (${options.id}) as apiKey was undefined`;
    }

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
