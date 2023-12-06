import {
  EventFilter,
  ExternalSource,
  ExternalSourceTrigger,
  HandlerEvent,
  IntegrationTaskKey,
  Logger,
} from "@trigger.dev/sdk";
import {
  LinearDocument as L,
  LinearWebhooks,
  LINEAR_WEBHOOK_SIGNATURE_HEADER,
  LINEAR_WEBHOOK_TS_FIELD,
  WebhookPayload,
  DeletePayload,
  Webhook,
} from "@linear/sdk";
import { z } from "zod";
import * as events from "./events";
import { Linear, LinearRunTask, serializeLinearOutput } from "./index";
import { WebhookPayloadSchema } from "./schemas";
import { LinearReturnType } from "./types";
import { queryProperties } from "./utils";
import { Buffer } from "node:buffer";

export class Webhooks {
  runTask: LinearRunTask;

  constructor(runTask: LinearRunTask) {
    this.runTask = runTask;
  }

  webhook(key: IntegrationTaskKey, params: { id: string }): LinearReturnType<Webhook> {
    return this.runTask(
      key,
      async (client, task, io) => {
        return serializeLinearOutput(await client.webhook(params.id));
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
    params?: L.WebhooksQueryVariables
  ): LinearReturnType<Webhook[]> {
    return this.runTask(
      key,
      async (client, task, io) => {
        let connections = await client.webhooks(params);
        const hooks = connections.nodes;
        while (connections.pageInfo.hasNextPage) {
          connections = await connections.fetchNext();
          hooks.push(...connections.nodes);
        }
        return serializeLinearOutput(hooks);
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
    params: L.WebhookCreateInput
  ): LinearReturnType<Omit<WebhookPayload, "webhook"> & { webhook: Webhook | undefined }> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const payload = await client.createWebhook({ ...params, allPublicTeams: !params.teamId });
        return serializeLinearOutput({
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

  deleteWebhook(key: IntegrationTaskKey, params: { id: string }): LinearReturnType<DeletePayload> {
    return this.runTask(
      key,
      async (client, task, io) => {
        return serializeLinearOutput(await client.deleteWebhook(params.id));
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
    params: { id: string; input: L.WebhookUpdateInput }
  ): LinearReturnType<Omit<WebhookPayload, "webhook"> & { webhook: Webhook | undefined }> {
    return this.runTask(
      key,
      async (client, task) => {
        const payload = await client.updateWebhook(params.id, params.input);
        return serializeLinearOutput({
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

type LinearEvents = (typeof events)[keyof typeof events];

export type TriggerParams = {
  teamId?: string;
  filter?: EventFilter;
};

type CreateTriggersResult<TEventSpecification extends LinearEvents> = ExternalSourceTrigger<
  TEventSpecification,
  ReturnType<typeof createWebhookEventSource>
>;

export function createTrigger<TEventSpecification extends LinearEvents>(
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

const WebhookRegistrationDataSchema = z.object({
  success: z.literal(true),
  webhook: z.object({
    id: z.string(),
    enabled: z.boolean(),
  }),
});

export function createWebhookEventSource(
  integration: Linear
): ExternalSource<Linear, TriggerParams, "HTTP", {}> {
  return new ExternalSource("HTTP", {
    id: "linear.webhook",
    schema: z.object({
      teamId: z.string().optional(),
    }),
    version: "0.1.0",
    integration,
    key: (params) => `${params.teamId ? params.teamId : "all"}`,
    handler: webhookHandler,
    register: async (event, io, ctx) => {
      const { params, source: httpSource, options } = event;

      // (key-specific) stored data, undefined if not registered yet
      const webhookData = WebhookRegistrationDataSchema.safeParse(httpSource.data);

      // set of events to register
      const allEvents = Array.from(new Set([...options.event.desired, ...options.event.missing]));
      const registeredOptions = {
        event: allEvents,
      };

      // easily identify webhooks on linear
      const label = `trigger.${params.teamId ? params.teamId : "all"}`;

      if (httpSource.active && webhookData.success) {
        const hasMissingOptions = Object.values(options).some(
          (option) => option.missing.length > 0
        );
        if (!hasMissingOptions) return;

        const updatedWebhook = await io.integration.updateWebhook("update-webhook", {
          id: webhookData.data.webhook.id,
          input: {
            label,
            resourceTypes: allEvents,
            secret: httpSource.secret,
            url: httpSource.url,
          },
        });

        return {
          data: WebhookRegistrationDataSchema.parse(updatedWebhook),
          options: registeredOptions,
        };
      }

      // check for existing hooks that match url
      const listResponse = await io.integration.webhooks("list-webhooks");
      const existingWebhook = listResponse.find((w) => w.url === httpSource.url);

      if (existingWebhook) {
        const updatedWebhook = await io.integration.updateWebhook("update-webhook", {
          id: existingWebhook.id,
          input: {
            label,
            resourceTypes: allEvents,
            secret: httpSource.secret,
            url: httpSource.url,
          },
        });

        return {
          data: WebhookRegistrationDataSchema.parse(updatedWebhook),
          options: registeredOptions,
        };
      }

      const createPayload = await io.integration.createWebhook("create-webhook", {
        label,
        resourceTypes: allEvents,
        secret: httpSource.secret,
        teamId: params.teamId,
        url: httpSource.url,
      });

      return {
        data: WebhookRegistrationDataSchema.parse(createPayload),
        secret: (await createPayload.webhook)?.secret,
        options: registeredOptions,
      };
    },
  });
}

async function webhookHandler(event: HandlerEvent<"HTTP">, logger: Logger, integration: Linear) {
  logger.debug("[@trigger.dev/linear] Handling webhook payload");

  const { rawEvent: request, source } = event;

  const LINEAR_IPS = ["35.231.147.226", "35.243.134.228"];

  const clientIp =
    request.headers.get("cf-connecting-ip") ??
    (
      request.headers.get("x-real-ip") ??
      request.headers.get("x-forwarded-for") ??
      // default to allowing request if expected headers missing
      LINEAR_IPS[0]
    ).split(",")[0];

  if (!LINEAR_IPS.includes(clientIp)) {
    logger.error("[@trigger.dev/linear] Error validating webhook source, IP invalid.");
    throw Error("[@trigger.dev/linear] Invalid source IP.");
  }

  const payloadUuid = request.headers.get("Linear-Delivery");
  const payloadEvent = request.headers.get("Linear-Event");

  if (!payloadUuid || !payloadEvent) {
    logger.debug("[@trigger.dev/linear] Missing required Linear headers");
    return { events: [] };
  }

  if (!request.body) {
    logger.debug("[@trigger.dev/linear] No body found");
    return { events: [] };
  }

  const signature = request.headers.get(LINEAR_WEBHOOK_SIGNATURE_HEADER);

  if (!signature) {
    logger.error("[@trigger.dev/linear] Error validating webhook signature, no signature found");
    throw Error("[@trigger.dev/linear] No signature found");
  }

  const rawBody = await request.text();
  const body = JSON.parse(rawBody);
  const webhookHelper = new LinearWebhooks(source.secret);

  if (!webhookHelper.verify(Buffer.from(rawBody), signature, body[LINEAR_WEBHOOK_TS_FIELD])) {
    logger.error("[@trigger.dev/linear] Error validating webhook signature, they don't match");
    throw Error("[@trigger.dev/linear] Invalid signature");
  }

  const webhookPayload = WebhookPayloadSchema.parse(body);

  return {
    events: [
      {
        id: payloadUuid,
        name: payloadEvent,
        source: "linear.app",
        payload: webhookPayload,
        context: {},
      },
    ],
  };
}
