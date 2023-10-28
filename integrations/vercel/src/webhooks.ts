import { IntegrationTaskKey } from "@trigger.dev/sdk";
import { VercelRunTask } from "./index";
import { WebhookListData, WebhookRegistrationData } from "./client";

export class Webhooks {
  runTask: VercelRunTask;

  constructor(runTask: VercelRunTask) {
    this.runTask = runTask;
  }

  list(key: IntegrationTaskKey, params: { teamId: string }): Promise<WebhookListData> {
    return this.runTask(
      key,
      async (client, task, io) => {
        return await client.listWebhooks({ ...params });
      },
      {
        name: "List Webhooks",
        params,
        properties: [{ label: "Team ID", text: params.teamId }],
      }
    );
  }

  create(
    key: IntegrationTaskKey,
    params: { teamId: string; events: string[]; url: string; projectIds?: string[] }
  ): Promise<WebhookRegistrationData> {
    return this.runTask(
      key,
      async (client, task, io) => {
        return await client.createWebhook({ ...params });
      },
      {
        name: "Create Webhook",
        params,
        properties: [
          { label: "Team ID", text: params.teamId },
          { label: "Webhook URL", text: params.url },
          { label: "Events", text: params.events.join(", ") },
        ],
      }
    );
  }

  delete(key: IntegrationTaskKey, params: { webhookId: string }): Promise<void> {
    return this.runTask(
      key,
      async (client, task, io) => {
        return await client.deleteWebhook({ ...params });
      },
      {
        name: "Delete Webhook",
        params,
        properties: [{ label: "Webhook ID", text: params.webhookId }],
      }
    );
  }

  update(
    key: IntegrationTaskKey,
    params: {
      webhookId: string;
      teamId: string;
      events: string[];
      url: string;
      projectIds?: string[];
    }
  ): Promise<WebhookRegistrationData> {
    return this.runTask(
      key,
      async (client, task) => {
        return await client.updateWebhook({ ...params });
      },
      {
        name: "Update Webhook",
        params,
        properties: [
          { label: "Team ID", text: params.teamId },
          { label: "Webhook URL", text: params.url },
          { label: "Events", text: params.events.join(", ") },
        ],
      }
    );
  }
}
