import { z } from "zod";

const WebhookRegistrationDataSchema = z.object({
  id: z.string(),
  secret: z.string(),
  events: z.array(z.string()),
  url: z.string(),
  ownerId: z.string(),
  projectIds: z.array(z.string()).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type WebhookRegistrationData = z.infer<typeof WebhookRegistrationDataSchema>;

const WebhookListDataSchema = WebhookRegistrationDataSchema.omit({ secret: true });

export type WebhookListData = z.infer<typeof WebhookListDataSchema>;

export class VercelClient {
  constructor(private apiToken: string) {}

  async createWebhook(
    teamId: string,
    events: string[],
    url: string,
    projectIds?: string[]
  ): Promise<WebhookRegistrationData> {
    const body = {
      events,
      url,
      projectIds,
    };

    const res = await fetch(`https://api.vercel.com/v1/webhooks?teamId=${teamId}`, {
      method: "post",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`failed to create webhook: ${res.statusText}`);
    }

    const webhook = await res.json();

    return WebhookRegistrationDataSchema.parse(webhook);
  }

  async listWebhooks(teamId: string): Promise<WebhookListData> {
    const res = await fetch(`https://api.vercel.com/v1/webhooks?teamId=${teamId}`, {
      method: "get",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });

    if (!res.ok) {
      const errorText = await res
        .text()
        .then((t) => t)
        .catch((e) => "No body");

      throw new Error(`failed to list webhooks: ${res.statusText}`);
    }

    const webhooks = await res.json();

    return WebhookListDataSchema.parse(webhooks);
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    const res = await fetch(`https://api.vercel.com/v1/webhooks/${webhookId}`, {
      method: "delete",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });

    if (!res.ok) {
      throw new Error(`failed to delete webhook: ${res.statusText}`);
    }
  }
}
