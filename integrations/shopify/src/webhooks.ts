import { IntegrationTaskKey, verifyRequestSignature } from "@trigger.dev/sdk";
import { z } from "zod";
import * as events from "./events";
import { Shopify, ShopifyRunTask } from "./index";
import {
  WebhookHeaderSchema,
  WebhookPayloadSchema,
  WebhookSubscription,
  WebhookSubscriptionDataSchema,
  WebhookTopic,
  WebhookTopicSchema,
} from "./schemas";
import { WebhookSource, WebhookTrigger } from "@trigger.dev/sdk/triggers/webhook";

export class Webhooks {
  runTask: ShopifyRunTask;
  apiUrl: URL;

  constructor(
    runTask: ShopifyRunTask,
    private shopDomain: string,
    apiVersion: string,
    private adminAccessToken: string
  ) {
    this.runTask = runTask;
    this.apiUrl = new URL(`/admin/api/${apiVersion}/`, `https://${shopDomain}`);
  }

  create(
    key: IntegrationTaskKey,
    params: {
      topic: WebhookTopic;
      address: string;
      fields?: string[];
    }
  ): Promise<WebhookSubscription> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const session = client.session.customAppSession(this.shopDomain);
        session.accessToken = this.adminAccessToken;

        const webhook = new client.rest.Webhook({ session: session });

        webhook.topic = params.topic;
        webhook.address = params.address;
        webhook.format = "json";
        webhook.fields = params.fields ?? null;

        await webhook.save({
          update: true,
        });

        // TODO: use typed serializer
        return JSON.parse(JSON.stringify(webhook));
      },
      {
        name: "Create Webhook",
        params,
        properties: [
          { label: "Webhook URL", text: params.address },
          { label: "Topic", text: params.topic },
        ],
      }
    );
  }

  // just here as an example if we ever want better platform support
  #createWithFetch(
    key: IntegrationTaskKey,
    params: {
      topic: WebhookTopic;
      address: string;
      fields?: string[];
    }
  ): Promise<WebhookSubscription> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const resource = {
          webhook: {
            topic: params.topic,
            address: params.address,
            fields: params.fields,
          },
        };

        const request = new Request(new URL("webhooks.json", this.apiUrl), {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": this.adminAccessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(resource),
        });

        const response = await fetch(request.clone());

        if (!response.ok) {
          await handleWebhookError("WEBHOOK_CREATE", request, response);
        }

        const webhook = await response.json();
        const parsed = WebhookSubscriptionDataSchema.parse(webhook);
        return parsed.webhook;
      },
      {
        name: "Create Webhook with Fetch",
        params,
        properties: [
          { label: "Webhook URL", text: params.address },
          { label: "Topic", text: params.topic },
        ],
      }
    );
  }

  delete(key: IntegrationTaskKey, params: { id: number }): Promise<unknown> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const session = client.session.customAppSession(this.shopDomain);
        session.accessToken = this.adminAccessToken;

        const deleteResult = await client.rest.Webhook.delete({ session, id: params.id });

        return JSON.parse(JSON.stringify(deleteResult));
      },
      {
        name: "Delete Webhook",
        params,
        properties: [{ label: "Webhook ID", text: String(params.id) }],
      }
    );
  }

  update(
    key: IntegrationTaskKey,
    params: {
      id: number;
      topic: WebhookTopic;
      address: string;
      fields?: string[];
    }
  ): Promise<WebhookSubscription> {
    return this.runTask(
      key,
      async (client, task) => {
        const session = client.session.customAppSession(this.shopDomain);
        session.accessToken = this.adminAccessToken;

        const webhook = new client.rest.Webhook({ session: session });

        webhook.id = params.id;
        webhook.topic = params.topic;
        webhook.address = params.address;
        webhook.format = "json";
        webhook.fields = params.fields ?? null;

        await webhook.save({
          update: true,
        });

        // TODO: use typed serializer
        return JSON.parse(JSON.stringify(webhook));
      },
      {
        name: "Update Webhook",
        params,
        properties: [
          { label: "Webhook ID", text: String(params.id) },
          { label: "Webhook URL", text: params.address },
          { label: "Topic", text: params.topic },
        ],
      }
    );
  }
}

type ShopifyEvents = (typeof events)[keyof typeof events];

export type TriggerParams = {
  topic: WebhookTopic;
};

type CreateTriggersResult<TEventSpecification extends ShopifyEvents> = WebhookTrigger<
  TEventSpecification,
  ReturnType<typeof createWebhookEventSource>
>;

export function createTrigger<TEventSpecification extends ShopifyEvents>(
  source: ReturnType<typeof createWebhookEventSource>,
  event: TEventSpecification,
  params: TriggerParams
): CreateTriggersResult<TEventSpecification> {
  return new WebhookTrigger({
    event,
    params,
    source,
    config: {},
  });
}

export function createWebhookEventSource(
  integration: Shopify
): WebhookSource<Shopify, TriggerParams> {
  return new WebhookSource({
    id: "shopify.webhook",
    schemas: {
      params: z.object({
        topic: WebhookTopicSchema,
      }),
    },
    version: "0.1.0",
    integration,
    key: (params) => params.topic,
    crud: {
      create: async ({ io, ctx }) => {
        const webhook = await io.integration.webhooks.create("create-webhook", {
          address: ctx.url,
          topic: ctx.params.topic,
          fields: ctx.config.desired.fields,
        });

        await io.store.job.set("set-id", "webhook-id", webhook.id);
      },
      delete: async ({ io, ctx }) => {
        const webhookId = await io.store.job.get("get-webhook-id", "webhook-id");

        await io.integration.webhooks.delete("delete-webhook", {
          id: webhookId,
        });

        await io.store.job.delete("delete-webhook-id", "webhook-id");
      },
      update: async ({ io, ctx }) => {
        const webhookId = await io.store.job.get("get-webhook-id", "webhook-id");

        await io.integration.webhooks.update("update-webhook", {
          id: webhookId,
          address: ctx.url,
          topic: ctx.params.topic,
          fields: ctx.config.desired.fields,
        });
      },
    },
    verify: async ({ request, io, ctx }) => {
      return await verifyRequestSignature({
        request,
        headerName: "x-shopify-hmac-sha256",
        headerEncoding: "base64",
        secret: io.integration.clientSecret,
        algorithm: "sha256",
      });
    },
    generateEvents: async ({ request, io, ctx }) => {
      const headers = WebhookHeaderSchema.parse(Object.fromEntries(request.headers));

      const topic = headers["x-shopify-topic"];
      const triggeredAt = headers["x-shopify-triggered-at"];
      const idempotencyKey = headers["x-shopify-webhook-id"];

      const payload = WebhookPayloadSchema.parse(await request.json());

      await io.sendEvent("send-event", {
        id: idempotencyKey,
        payload,
        source: "shopify.com",
        name: topic,
        timestamp: triggeredAt,
      });
    },
  });
}

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    readonly request: Request,
    readonly response: Response
  ) {
    super(message);
    this.name = "ShopifyApiError";
  }
}

async function handleWebhookError(errorType: string, request: Request, response: Response) {
  const body = await response.clone().text();

  const message = `[${errorType}] ${response.status} - ${response.statusText} - body: "${body}"`;

  throw new ShopifyApiError(message, request, response);
}
