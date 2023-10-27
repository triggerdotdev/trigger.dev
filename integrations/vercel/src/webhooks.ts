import {
  EventFilter,
  ExternalSource,
  ExternalSourceTrigger,
  HandlerEvent,
  IntegrationTaskKey,
  Logger,
} from "@trigger.dev/sdk";
import { Document, VercelWebhooks, WebhookPayload, DeletePayload, Webhook } from "vercel";
import { z } from "zod";
import * as events from "./events";
import { Vercel, VercelRunTask, serializeVercelOutput } from "./index";
import { WebhookPayloadSchema } from "./schemas";
import { VercelReturnType } from "./types";
import { queryProperties } from "./utils";
import { WebhookRegistrationDataSchema } from "./client";

export class Webhooks {
  runTask: VercelRunTask;

  constructor(runTask: VercelRunTask) {
    this.runTask = runTask;
  }

  webhook(key: IntegrationTaskKey, params: { id: string }): VercelReturnType<Webhook> {
    return this.runTask(
      key,
      async (client, task, io) => {
        return serializeVercelOutput(await client.webhook(params.id));
      },
      {
        name: "Get Webhook",
        params,
        properties: [{ label: "Webhook ID", text: params.id }],
      }
    );
  }

  webhooks(
    key: IntegrationTaskKey,
    params?: Document.WebhooksQueryVariables
  ): VercelReturnType<Webhook[]> {
    return this.runTask(
      key,
      async (client, task, io) => {
        let connections = await client.webhooks(params);
        const hooks = connections.nodes;
        while (connections.pageInfo.hasNextPage) {
          connections = await connections.fetchNext();
          hooks.push(...connections.nodes);
        }
        return serializeVercelOutput(hooks);
      },
      {
        name: "List Webhooks",
        params,
        properties: queryProperties(params ?? {}),
      }
    );
  }

  createWebhook(
    key: IntegrationTaskKey,
    params: Document.WebhookCreateInput
  ): VercelReturnType<Omit<WebhookPayload, "webhook"> & { webhook: Webhook | undefined }> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const payload = await client.createWebhook({ ...params, allPublicTeams: !params.teamId });
        return serializeVercelOutput({
          ...payload,
          webhook: await payload.webhook,
        });
      },
      {
        name: "Create Webhook",
        params,
        properties: [
          { label: "Webhook URL", text: params.url },
          { label: "Resource Types", text: params.resourceTypes.join(", ") },
        ],
      }
    );
  }

  deleteWebhook(key: IntegrationTaskKey, params: { id: string }): VercelReturnType<DeletePayload> {
    return this.runTask(
      key,
      async (client, task, io) => {
        return serializeVercelOutput(await client.deleteWebhook(params.id));
      },
      {
        name: "Delete Webhook",
        params,
        properties: [{ label: "Webhook ID", text: params.id }],
      }
    );
  }

  updateWebhook(
    key: IntegrationTaskKey,
    params: { id: string; events: string[] }
  ): VercelReturnType<Omit<WebhookPayload, "webhook"> & { webhook: Webhook | undefined }> {
    return this.runTask(
      key,
      async (client, task) => {
        const payload = await client.updateWebhook(params.id, params.input);
        return serializeVercelOutput({
          ...payload,
          webhook: await payload.webhook,
        });
      },
      {
        name: "Update Webhook",
        params,
        properties: [
          { label: "Webhook ID", text: params.id },
          ...(params.input.url ? [{ label: "Webhook URL", text: params.input.url }] : []),
          ...(params.input.resourceTypes
            ? [{ label: "Resource Types", text: params.input.resourceTypes.join(", ") }]
            : []),
        ],
      }
    );
  }
}

type VercelEvents = (typeof events)[keyof typeof events];

export type TriggerParams = {
  teamId: string;
  projectIds?: string[];
};

type CreateTriggersResult<TEventSpecification extends VercelEvents> = ExternalSourceTrigger<
  TEventSpecification,
  ReturnType<typeof createWebhookEventSource>
>;

export function createTrigger<TEventSpecification extends VercelEvents>(
  source: ReturnType<typeof createWebhookEventSource>,
  event: TEventSpecification,
  params: TriggerParams
): CreateTriggersResult<TEventSpecification> {
  return new ExternalSourceTrigger({
    event,
    params,
    source,
    options: {},
  });
}

const HttpSourceDataSchema = z.object({
  id: z.string(),
  secret: z.string(),
});

export function createWebhookEventSource(
  integration: Vercel
): ExternalSource<Vercel, TriggerParams, "HTTP", {}> {
  return new ExternalSource("HTTP", {
    id: "vercel.webhook",
    schema: z.object({
      teamId: z.string(),
      projectIds: z.array(z.string()).optional(),
    }),
    version: "0.1.0",
    integration,
    key: (params) => `${params.teamId}/${params.projectIds ? params.projectIds.join(".") : "all"}`,
    handler: webhookHandler,
    register: async (event, io, ctx) => {
      const { params, source: httpSource, options } = event;

      // (key-specific) stored data, undefined if not registered yet
      const webhookData = HttpSourceDataSchema.safeParse(httpSource.data);

      // set of events to register
      const allEvents = Array.from(new Set([...options.event.desired, ...options.event.missing]));
      const registeredOptions = {
        event: allEvents,
      };

      if (httpSource.active && webhookData.success) {
        const hasMissingOptions = Object.values(options).some(
          (option) => option.missing.length > 0
        );
        if (!hasMissingOptions) return;

        const updatedWebhook = await io.integration.updateWebhook("update-webhook", {
          id: webhookData.data.id,
          events: allEvents,
        });

        return {
          data: HttpSourceDataSchema.parse(updatedWebhook),
          options: registeredOptions,
        };
      }

      // check for existing hooks that match url
      const listResponse = await io.integration.webhooks("list-webhooks");
      const existingWebhook = listResponse.find((w) => w.url === httpSource.url);

      if (existingWebhook) {
        const updatedWebhook = await io.integration.updateWebhook("update-webhook", {
          id: existingWebhook.id,
          events: allEvents,
          teamId: params.teamId,
          url: httpSource.url,
        });

        return {
          data: HttpSourceDataSchema.parse(updatedWebhook),
          options: registeredOptions,
        };
      }

      const createdWebhook = await io.integration.createWebhook("create-webhook", {
        events: allEvents,
        teamId: params.teamId,
        url: httpSource.url,
      });

      return {
        data: HttpSourceDataSchema.parse(createdWebhook),
        secret: createdWebhook.secret,
        options: registeredOptions,
      };
    },
  });
}

async function webhookHandler(event: HandlerEvent<"HTTP">, logger: Logger, integration: Vercel) {
  logger.debug("[@trigger.dev/vercel] Handling webhook payload");

  const { rawEvent: request, source } = event;

  const payloadUuid = request.headers.get("Vercel-Delivery");
  const payloadEvent = request.headers.get("Vercel-Event");

  if (!payloadUuid || !payloadEvent) {
    logger.debug("[@trigger.dev/vercel] Missing required Vercelheaders");
    return { events: [] };
  }

  if (!request.body) {
    logger.debug("[@trigger.dev/vercel] No body found");
    return { events: [] };
  }

  const signature = request.headers.get("WEBHOOK_SIGNATURE_HEADER");

  if (!signature) {
    logger.error("[@trigger.dev/vercel] Error validating webhook signature, no signature found");
    throw Error("[@trigger.dev/vercel] No signature found");
  }

  const rawBody = await request.text();
  const body = JSON.parse(rawBody);
  const webhookHelper = new VercelWebhooks(source.secret);

  if (!webhookHelper.verify(Buffer.from(rawBody), signature)) {
    logger.error("[@trigger.dev/vercel] Error validating webhook signature, they don't match");
    throw Error("[@trigger.dev/vercel] Invalid signature");
  }

  const webhookPayload = WebhookPayloadSchema.parse(body);

  return {
    events: [
      {
        id: payloadUuid,
        name: payloadEvent,
        source: "vercel.app",
        payload: webhookPayload,
        context: {},
      },
    ],
  };
}
