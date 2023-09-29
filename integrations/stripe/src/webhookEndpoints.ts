import { IntegrationTaskKey } from "@trigger.dev/sdk";
import {
  CreateWebhookParams,
  CreateWebhookResponse,
  ListWebhooksParams,
  ListWebhooksResponse,
  StripeRunTask,
  UpdateWebhookParams,
  UpdateWebhookResponse,
} from "./index";
import { omit } from "./utils";

export class WebhookEndpoints {
  constructor(private runTask: StripeRunTask) {}

  create(key: IntegrationTaskKey, params: CreateWebhookParams): Promise<CreateWebhookResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        const response = await client.webhookEndpoints.create(params, {
          idempotencyKey: task.idempotencyKey,
        });

        task.outputProperties = [
          {
            label: "Webhook ID",
            text: response.id,
          },
          ...(response.lastResponse.requestId
            ? [
                {
                  label: "Request ID",
                  text: response.lastResponse.requestId,
                },
              ]
            : []),
        ];

        return response;
      },
      {
        name: "Create Webhook",
        params,
      }
    );
  }

  update(key: IntegrationTaskKey, params: UpdateWebhookParams): Promise<UpdateWebhookResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        const response = await client.webhookEndpoints.update(params.id, omit(params, "id"), {
          idempotencyKey: task.idempotencyKey,
        });

        task.outputProperties = [
          ...(response.lastResponse.requestId
            ? [
                {
                  label: "Request ID",
                  text: response.lastResponse.requestId,
                },
              ]
            : []),
        ];

        return response;
      },
      {
        name: "Update Webhook",
        params,
        icon: "stripe",
        properties: [
          {
            label: "Webhook ID",
            text: params.id,
          },
        ],
      }
    );
  }

  list(key: IntegrationTaskKey, params: ListWebhooksParams): Promise<ListWebhooksResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        const response = await client.webhookEndpoints.list(params);

        return response;
      },
      {
        name: "List Webhooks",
        params,
      }
    );
  }
}
