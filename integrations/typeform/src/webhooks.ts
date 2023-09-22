import { IntegrationTaskKey } from "@trigger.dev/sdk";
import {
  CreateWebhookParams,
  DeleteWebhookParams,
  DeleteWebhookResponse,
  GetWebhookParams,
  GetWebhookResponse,
  ListWebhooksParams,
  ListWebhooksResponse,
  TypeformRunTask,
  UpdateWebhookParams,
} from ".";

export class Webhooks {
  constructor(private runTask: TypeformRunTask) {}

  create(key: IntegrationTaskKey, params: CreateWebhookParams): Promise<GetWebhookResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.webhooks.create(params);
      },
      {
        name: "Create Webhook",
        params,
        properties: [
          {
            label: "Form ID",
            text: params.uid,
          },
          {
            label: "Tag",
            text: params.tag,
          },
        ],
      }
    );
  }

  list(key: IntegrationTaskKey, params: ListWebhooksParams): Promise<ListWebhooksResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.webhooks.list(params);
      },
      {
        name: "List Webhooks",
        params,
        properties: [
          {
            label: "Form ID",
            text: params.uid,
          },
        ],
      }
    );
  }

  update(key: IntegrationTaskKey, params: UpdateWebhookParams): Promise<GetWebhookResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.webhooks.update(params);
      },
      {
        name: "Update Webhook",
        params,
        properties: [
          {
            label: "Form ID",
            text: params.uid,
          },
          {
            label: "Tag",
            text: params.tag,
          },
        ],
      }
    );
  }

  get(key: IntegrationTaskKey, params: GetWebhookParams): Promise<GetWebhookResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.webhooks.get(params);
      },
      {
        name: "Get Webhook",
        params,
        properties: [
          {
            label: "Form ID",
            text: params.uid,
          },
          {
            label: "Tag",
            text: params.tag,
          },
        ],
      }
    );
  }

  delete(key: IntegrationTaskKey, params: DeleteWebhookParams): Promise<DeleteWebhookResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.webhooks.delete(params);
      },
      {
        name: "Delete Webhook",
        params,
        properties: [
          {
            label: "Form ID",
            text: params.uid,
          },
          {
            label: "Tag",
            text: params.tag,
          },
        ],
      }
    );
  }
}
