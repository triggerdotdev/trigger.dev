import { IntegrationTaskKey, verifyRequestSignature } from "@trigger.dev/sdk";
import { z } from "zod";
import * as events from "./events";
import { Shopify, ShopifyRunTask } from "./index";
import {
  WebhookHeaderSchema,
  WebhookSubscription,
  WebhookSubscriptionDataSchema,
  WebhookTopic,
  WebhookTopicSchema,
} from "./schemas";
import { WebhookSource, WebhookTrigger } from "@trigger.dev/sdk/triggers/webhook";

export class Webhooks {
  constructor(private runTask: ShopifyRunTask) {}

  #apiUrl(client: NonNullable<Shopify["_client"]>) {
    const { apiVersion, hostName } = client.config;
    return new URL(`/admin/api/${apiVersion}/`, `https://${hostName}`);
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

        const request = new Request(new URL("webhooks.json", this.#apiUrl(client)), {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": client.config.adminApiAccessToken,
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
}

type ShopifyEvents = (typeof events)[keyof typeof events];

export type TriggerParams = {
  topic: WebhookTopic;
  fields?: string[];
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

export function createWebhookEventSource(integration: Shopify): WebhookSource<Shopify> {
  return new WebhookSource({
    id: "shopify.webhook",
    schemas: {
      params: z.object({
        topic: WebhookTopicSchema,
      }),
      config: z.record(z.string().array()),
    },
    version: "0.1.0",
    integration,
    key: (params) => params.topic,
    crud: {
      create: async ({ io, ctx }) => {
        const webhook = await io.integration.rest.Webhook.save("create-webhook", {
          fromData: {
            address: ctx.url,
            topic: ctx.params.topic,
            fields: ctx.config.desired.fields,
          },
        });

        await io.store.job.set("set-id", "webhook-id", webhook.id);
      },
      delete: async ({ io, ctx }) => {
        const webhookId = await io.store.job.get<number>("get-webhook-id", "webhook-id");

        await io.integration.rest.Webhook.delete("delete-webhook", {
          id: webhookId,
        });

        await io.store.job.delete("delete-webhook-id", "webhook-id");
      },
      update: async ({ io, ctx }) => {
        const webhookId = await io.store.job.get<number>("get-webhook-id", "webhook-id");

        await io.integration.rest.Webhook.save("update-webhook", {
          fromData: {
            id: webhookId,
            address: ctx.url,
            topic: ctx.params.topic,
            fields: ctx.config.desired.fields,
          },
        });
      },
    },
    verify: async ({ request, io, ctx }) => {
      const clientSecret = await io.integration.runTask(
        "get-client-secret",
        async (client) => client.config.apiSecretKey
      );

      return await verifyRequestSignature({
        request,
        headerName: "x-shopify-hmac-sha256",
        headerEncoding: "base64",
        secret: clientSecret,
        algorithm: "sha256",
      });
    },
    generateEvents: async ({ request, io, ctx }) => {
      const headers = WebhookHeaderSchema.parse(Object.fromEntries(request.headers));

      const topic = headers["x-shopify-topic"];
      const triggeredAt = headers["x-shopify-triggered-at"];
      const idempotencyKey = headers["x-shopify-webhook-id"];

      await io.sendEvent("send-event", {
        id: idempotencyKey,
        payload: await request.json(),
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
