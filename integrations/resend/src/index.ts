import type { IntegrationClient, TriggerIntegration } from "@trigger.dev/sdk";
import { Resend as ResendClient } from "resend";

import type { AuthenticatedTask } from "@trigger.dev/sdk";

type SendEmailData = Parameters<InstanceType<typeof ResendClient>["sendEmail"]>[0];

type SendEmailResponse = { id: string };

export const sendEmail: AuthenticatedTask<
  InstanceType<typeof ResendClient>,
  SendEmailData,
  SendEmailResponse
> = {
  run: async (params, client) => {
    let retry = true;
    let response: SendEmailResponse | null = null;

    while (retry) {
      try {
        response = await client.sendEmail(params) as SendEmailResponse;
        retry = false; // Success, no need to retry
      } catch (error:any) {
        
        if (error.response && error.response.status === 429) {
          // Rate limit exceeded, retry after waiting
          const rateLimitReset = parseInt(error.response.headers['x-ratelimit-reset'] || '0', 10) * 1000;
          const currentTime = Date.now();
          const waitTime = Math.max(rateLimitReset - currentTime, 0);

          if (waitTime > 0) {
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        } else {
          // Some other error occurred, do not retry
          retry = false;
          throw error;
        }
      }
    }

    if (response) {
      return response;
    } else {
      throw new Error("Failed to send email after retries.");
    }
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
