import { IntegrationTaskKey, verifyRequestSignature } from "@trigger.dev/sdk";
import { z } from "zod";
import { Shopify, ShopifyRunTask } from "./index";
import {
  WebhookHeaderSchema,
  WebhookSubscription,
  WebhookSubscriptionDataSchema,
  WebhookTopic,
  WebhookTopicSchema,
} from "./schemas";
import { WebhookSource } from "@trigger.dev/sdk/triggers/webhook";

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

export function createWebhookEventSource(integration: Shopify) {
  return new WebhookSource({
    id: "shopify",
    schemas: {
      params: z.object({
        topic: WebhookTopicSchema,
        fields: z.string().array().optional(),
      }),
      // config: z.record(z.string().array()),
    },
    version: "0.1.0",
    integration,
    key: (params) => `${params.topic}-${params.fields?.join(".")}`,
    crud: {
      create: async ({ io, ctx }) => {
        const webhook = await io.integration.rest.Webhook.save("create-webhook", {
          fromData: {
            address: ctx.url,
            topic: ctx.params.topic,
            fields: ctx.params.fields,
            // fields: ctx.config.desired.fields,
          },
        });

        const clientSecret = await io.integration.runTask(
          "get-client-secret",
          async (client) => client.config.apiSecretKey
        );

        await io.store.job.set("set-id", "webhook-id", webhook.id);
        await io.store.job.set("set-secret", "webhook-secret", clientSecret);
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
            fields: ctx.params.fields,
            // fields: ctx.config.desired.fields,
          },
        });
      },
    },
    verify: async ({ request, apiClient, ctx }) => {
      // TODO: maybe pass namespace or shared store in context
      const registerJobNamespace = (key: string) => `job:webhook.register.${key}`;

      const clientSecret = await apiClient.store.get<string>(
        `${registerJobNamespace(ctx.key)}:webhook-secret`
      );

      return await verifyRequestSignature({
        request,
        headerName: "x-shopify-hmac-sha256",
        headerEncoding: "base64",
        secret: clientSecret,
        algorithm: "sha256",
      });
    },
    generateEvents: async ({ request, apiClient }) => {
      const headers = WebhookHeaderSchema.parse(Object.fromEntries(request.headers));

      const topic = headers["x-shopify-topic"];
      const triggeredAt = headers["x-shopify-triggered-at"];
      const idempotencyKey = headers["x-shopify-webhook-id"];

      await apiClient.sendEvent({
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
