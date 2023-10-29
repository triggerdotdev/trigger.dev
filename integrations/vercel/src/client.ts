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

const WebhookListDataSchema = z.array(WebhookRegistrationDataSchema.omit({ secret: true }));

export type WebhookListData = z.infer<typeof WebhookListDataSchema>;

export class VercelClient {
  constructor(private apiKey: string) {}

  async listWebhooks({ teamId }: { teamId: string }): Promise<WebhookListData> {
    const res = await fetch(`https://api.vercel.com/v1/webhooks?teamId=${teamId}`, {
      method: "get",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!res.ok) {
      throw new Error(`failed to list webhooks: ${res.statusText}`);
    }

    const webhooks = await res.json();

    return WebhookListDataSchema.parse(webhooks);
  }

  async createWebhook({
    teamId,
    events,
    url,
    projectIds,
  }: {
    teamId: string;
    events: string[];
    url: string;
    projectIds?: string[];
  }): Promise<WebhookRegistrationData> {
    const body = {
      events,
      url,
      projectIds,
    };

    const res = await fetch(`https://api.vercel.com/v1/webhooks?teamId=${teamId}`, {
      method: "post",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
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

  async deleteWebhook({ webhookId }: { webhookId: string }): Promise<void> {
    const res = await fetch(`https://api.vercel.com/v1/webhooks/${webhookId}`, {
      method: "delete",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!res.ok) {
      throw new Error(`failed to delete webhook: ${res.statusText}`);
    }
  }

  async updateWebhook({
    webhookId,
    teamId,
    events,
    url,
    projectIds,
  }: {
    webhookId: string;
    teamId: string;
    events: string[];
    url: string;
    projectIds?: string[];
  }): Promise<WebhookRegistrationData> {
    await this.deleteWebhook({ webhookId });
    return await this.createWebhook({ teamId, events, url, projectIds });
  }
}
