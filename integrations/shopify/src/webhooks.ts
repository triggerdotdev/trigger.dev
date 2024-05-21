import { IntegrationTaskKey, verifyRequestSignature, WebhookSource } from "@trigger.dev/sdk";
import { registerJobNamespace } from "@trigger.dev/integration-kit";
import { z } from "zod";
import { Shopify, ShopifyRunTask } from "./index";
import {
  WebhookHeaderSchema,
  WebhookSubscription,
  WebhookSubscriptionDataSchema,
  WebhookTopic,
  WebhookTopicSchema,
} from "./schemas";

export class Webhooks {
  constructor(private runTask: ShopifyRunTask) {}

  #apiUrl(client: NonNullable<Shopify["_client"]>) {
    const { apiVersion, hostName } = client.config;
    return new URL(`/admin/api/${apiVersion}/`, `https://${hostName}`);
  }

  // just an example using raw fetch with error handling
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
        // disabled for now, doesn't seem useful and complicates things
        // fields: z.string().array().optional(),
      }),
      // config: z.record(z.string().array()),
    },
    version: "0.1.0",
    integration,
    key: (params) => params.topic,
    crud: {
      create: async ({ io, ctx }) => {
        try {
          const webhook = await io.integration.rest.Webhook.save("create-webhook", {
            fromData: {
              address: ctx.url,
              topic: ctx.params.topic,
              // fields: ctx.params.fields,
            },
          });

          if (!webhook.id) {
            throw new Error(
              "Failed to create webhook. Ensure your Shopfiy client configuration is correct. Have you set the correct access scopes? Are you using the primary myshopify.com domain?"
            );
          }

          const clientSecret = await io.integration.runTask(
            "get-client-secret",
            async (client) => client.config.apiSecretKey
          );

          await io.store.job.set("set-id", "webhook-id", webhook.id);
          await io.store.job.set("set-secret", "webhook-secret", clientSecret);
        } catch (error) {
          if (error instanceof Error) {
            await io.logger.error(`Failed to create webhook: ${error.message}`);
          } else {
            await io.logger.error("Failed to create webhook", { rawError: error });
          }
          throw error;
        }
      },
      delete: async ({ io, ctx }) => {
        const webhookId = await io.store.job.get<number>("get-webhook-id", "webhook-id");

        if (!webhookId) {
          throw new Error("Missing webhook ID for delete operation.");
        }

        try {
          await io.integration.rest.Webhook.delete("delete-webhook", {
            id: webhookId,
          });
        } catch (error) {
          if (error instanceof Error) {
            await io.logger.error(`Failed to delete webhook: ${error.message}`);
          } else {
            await io.logger.error("Failed to delete webhook", { rawError: error });
          }
          throw error;
        }

        await io.store.job.delete("delete-webhook-id", "webhook-id");
      },
      update: async ({ io, ctx }) => {
        const webhookId = await io.store.job.get<number>("get-webhook-id", "webhook-id");

        try {
          await io.integration.rest.Webhook.save("update-webhook", {
            fromData: {
              id: webhookId,
              address: ctx.url,
              topic: ctx.params.topic,
              // fields: ctx.params.fields,
            },
          });
        } catch (error) {
          if (error instanceof Error) {
            await io.logger.error(`Failed to update webhook: ${error.message}`);
          } else {
            await io.logger.error("Failed to update webhook", { rawError: error });
          }
          throw error;
        }
      },
    },
    verify: async ({ request, client, ctx }) => {
      // TODO: should pass namespaced store instead, e.g. client.store.webhookRegistration.get()
      const clientSecret = await client.store.env.get<string>(
        `${registerJobNamespace(ctx.key)}:webhook-secret`
      );

      if (!clientSecret) {
        throw new Error("Missing secret for verification.");
      }

      return await verifyRequestSignature({
        request,
        headerName: "x-shopify-hmac-sha256",
        headerEncoding: "base64",
        secret: clientSecret,
        algorithm: "sha256",
      });
    },
    generateEvents: async ({ request, client }) => {
      const headers = WebhookHeaderSchema.parse(Object.fromEntries(request.headers));

      const topic = headers["x-shopify-topic"];
      const triggeredAt = headers["x-shopify-triggered-at"];
      const idempotencyKey = headers["x-shopify-webhook-id"];

      await client.sendEvent({
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
