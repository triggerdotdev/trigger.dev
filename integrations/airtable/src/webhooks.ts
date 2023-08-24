import {
  EventFilter,
  ExternalSource,
  ExternalSourceTrigger,
  HandlerEvent,
  IntegrationTaskKey,
  Logger,
} from "@trigger.dev/sdk";
import { Airtable, AirtableRunTask } from "./index";
import { z } from "zod";
import * as events from "./events";

const WebhookFromSourceSchema = z.union([
  z.literal("client"),
  z.literal("publicApi"),
  z.literal("formSubmission"),
  z.literal("automation"),
  z.literal("system"),
  z.literal("sync"),
  z.literal("anonymousUser"),
  z.literal("unknown"),
]);

type WebhookFromSource = z.infer<typeof WebhookFromSourceSchema>;
const WebhookDataTypeSchema = z.union([
  z.literal("tableData"),
  z.literal("tableFields"),
  z.literal("tableMetadata"),
]);
export type WebhookDataType = z.infer<typeof WebhookDataTypeSchema>;
const WebhookChangeTypeSchema = z.union([
  z.literal("add"),
  z.literal("remove"),
  z.literal("update"),
]);
export type WebhookChangeType = z.infer<typeof WebhookChangeTypeSchema>;
type WebhookSpecification = {
  filters: {
    dataTypes: WebhookDataType[];
    recordChangeScope?: string;
    changeTypes?: WebhookChangeType[];
    fromSources?: WebhookFromSource[];
  };
};

const apiUrl = "https://api.airtable.com/v0/bases";

export class Webhooks {
  runTask: AirtableRunTask;

  constructor(runTask: AirtableRunTask) {
    this.runTask = runTask;
  }

  create(
    key: IntegrationTaskKey,
    { baseId, url, options }: { baseId: string; url: string; options: WebhookSpecification }
  ) {
    return this.runTask<WebhookRegistrationData>(
      key,
      async (client, task, io) => {
        // create webhook
        const response = await fetch(`${apiUrl}/${baseId}/webhooks`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${client._apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            notificationUrl: url,
            specification: {
              options,
            },
          }),
          redirect: "follow",
        });

        if (!response.ok) {
          const errorText = await response
            .text()
            .then((t) => t)
            .catch((e) => "No body");

          throw new Error(
            `Failed to create webhook: ${response.status} ${response.statusText}\n${errorText}`
          );
        }

        const webhook = await response.json();
        const parsed = WebhookRegistrationDataSchema.parse(webhook);
        return parsed;
      },
      {
        name: "Create webhook",
        params: {
          baseId,
          url,
          options,
        },
      }
    );
  }

  list(key: IntegrationTaskKey, { baseId }: { baseId: string }) {
    return this.runTask<WebhookListData>(
      key,
      async (client, task, io) => {
        // create webhook
        const response = await fetch(`${apiUrl}/${baseId}/webhooks`, {
          headers: {
            Authorization: `Bearer ${client._apiKey}`,
          },
          redirect: "follow",
        });

        if (!response.ok) {
          throw new Error(`Failed to list webhooks: ${response.statusText}`);
        }

        const webhook = await response.json();
        const parsed = WebhookListDataSchema.parse(webhook);
        return parsed;
      },
      {
        name: "List webhooks",
        params: {
          baseId,
        },
      }
    );
  }

  delete(key: IntegrationTaskKey, { baseId, webhookId }: { baseId: string; webhookId: string }) {
    return this.runTask(
      key,
      async (client, task, io) => {
        // create webhook
        const response = await fetch(`${apiUrl}/${baseId}/webhooks/${webhookId}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${client._apiKey}`,
          },
          redirect: "follow",
        });

        if (!response.ok) {
          throw new Error(`Failed to delete webhook: ${response.statusText}`);
        }
      },
      {
        name: "Delete webhook",
        params: {
          baseId,
          webhookId,
        },
      }
    );
  }

  async update(
    key: IntegrationTaskKey,
    {
      baseId,
      url,
      webhookId,
      options,
    }: { baseId: string; url: string; webhookId: string; options: WebhookSpecification }
  ) {
    await this.delete(`${key}-delete`, { baseId, webhookId });
    return await this.create(`${key}-create`, { baseId, url, options });
  }
}

type AirtableEvents = (typeof events)[keyof typeof events];

export type TriggerParams = {
  baseId: string;
  filter?: EventFilter;
};

type CreateTriggersResult<TEventSpecification extends AirtableEvents> = ExternalSourceTrigger<
  TEventSpecification,
  ReturnType<typeof createWebhookEventSource>
>;

export function createTrigger<TEventSpecification extends AirtableEvents>(
  source: ReturnType<typeof createWebhookEventSource>,
  event: TEventSpecification,
  params: TriggerParams,
  options: {
    dataTypes: WebhookDataType[];
    changeTypes?: WebhookChangeType[];
    fromSources?: WebhookFromSource[];
  }
): CreateTriggersResult<TEventSpecification> {
  return new ExternalSourceTrigger({
    event,
    params,
    source,
    options,
  });
}

const WebhookRegistrationDataSchema = z.object({
  id: z.string(),
  expirationTime: z.string(),
  macSecretBase64: z.string(),
});

type WebhookRegistrationData = z.infer<typeof WebhookRegistrationDataSchema>;

const WebhookListDataSchema = z.object({
  webhooks: z.array(
    z.object({
      id: z.string(),
      notificationUrl: z.string(),
      expirationTime: z.coerce.date(),
      areNotificationsEnabled: z.boolean(),
      isHookEnabled: z.boolean(),
    })
  ),
});

type WebhookListData = z.infer<typeof WebhookListDataSchema>;

export function createWebhookEventSource(
  integration: Airtable
): ExternalSource<
  Airtable,
  { baseId: string; tableId?: string },
  "HTTP",
  { dataTypes: WebhookDataType[]; fromSources?: WebhookFromSource[] }
> {
  return new ExternalSource("HTTP", {
    id: "airtable.webhook",
    schema: z.object({ baseId: z.string(), tableId: z.string().optional() }),
    optionSchema: z.object({
      dataTypes: z.array(WebhookDataTypeSchema),
      fromSources: z.array(WebhookFromSourceSchema).optional(),
    }),
    version: "0.1.0",
    integration,
    filter: (params, options) => {
      //todo update this to filter using the fromSources
      return {};
    },
    key: (params) =>
      `airtable.webhook.${params.baseId}${params.tableId ? `.${params.tableId}` : ""}`,
    handler: webhookHandler,
    register: async (event, io, ctx) => {
      const { params, source: httpSource, options } = event;

      const webhookData = WebhookRegistrationDataSchema.safeParse(httpSource.data);

      const registeredOptions = {
        event: options.event.desired,
        dataTypes: options.dataTypes.desired,
        fromSources: options.fromSources?.desired,
      };

      const specification: WebhookSpecification = {
        filters: {
          dataTypes: options.dataTypes.desired as WebhookDataType[],
          changeTypes: options.event.desired as WebhookChangeType[],
          fromSources: options.fromSources?.desired as WebhookFromSource[],
          recordChangeScope: params.tableId,
        },
      };

      if (httpSource.active && webhookData.success) {
        const hasMissingOptions = Object.values(options).some(
          (option) => option.missing.length > 0
        );
        if (!hasMissingOptions) return;

        const updatedWebhook = await io.integration.webhooks().update("update-webhook", {
          baseId: params.baseId,
          url: httpSource.url,
          webhookId: webhookData.data.id,
          options: specification,
        });

        return {
          data: WebhookRegistrationDataSchema.parse(updatedWebhook),
          options: registeredOptions,
        };
      }

      const listResponse = await io.integration.webhooks().list("list-webhooks", {
        baseId: params.baseId,
      });

      const existingWebhook = listResponse.webhooks.find(
        (w) => w.notificationUrl === httpSource.url
      );

      if (existingWebhook) {
        const updatedWebhook = await io.integration.webhooks().update("update-webhook", {
          baseId: params.baseId,
          url: httpSource.url,
          webhookId: existingWebhook.id,
          options: specification,
        });

        return {
          data: WebhookRegistrationDataSchema.parse(updatedWebhook),
          options: registeredOptions,
        };
      }

      const webhook = await io.integration.webhooks().create("create-webhook", {
        url: httpSource.url,
        baseId: params.baseId,
        options: specification,
      });

      return {
        data: WebhookRegistrationDataSchema.parse(webhook),
        secret: webhook.macSecretBase64,
        options: registeredOptions,
      };
    },
  });
}

const WebhookPayloadSchema = z.object({
  base: z.object({
    id: z.string(),
  }),
  webhook: z.object({
    id: z.string(),
  }),
  timestamp: z.coerce.date(),
});

//todo add "metadata" to event: HandlerEvent<"HTTP">
//todo need to pass through the integration (ExternalSource has it), plus the auth
async function webhookHandler(event: HandlerEvent<"HTTP">, logger: Logger) {
  logger.debug("[@trigger.dev/airtable] Handling webhook payload");

  const { rawEvent: request, source } = event;

  if (!request.body) {
    logger.debug("[@trigger.dev/airtable] No body found");

    return { events: [] };
  }

  const rawBody = await request.text();

  const signature = request.headers.get("X-Airtable-Content-MAC");

  if (!signature) {
    logger.error("[@trigger.dev/airtable] Error validating webhook signature, no signature found");
    throw Error("[@trigger.dev/airtable] No signature found");
  }

  const hmac = require("crypto").createHmac("sha256", source.secret);
  hmac.update(rawBody, "ascii");
  const expectedContentHmac = "hmac-sha256=" + hmac.digest("hex");

  if (signature !== expectedContentHmac) {
    logger.error("[@trigger.dev/airtable] Error validating webhook signature, they don't match");
  }

  const payload = WebhookPayloadSchema.parse(JSON.parse(rawBody));

  //todo this all needs updating, to be the data fetched from the list payloads endpoint

  return {
    events: [
      {
        // id: payload.base.id,
        payload: payload,
        source: "airtable.com",
        name: "add",
        timestamp: payload.timestamp,
        context: {},
      },
    ],
    //todo the last cursor, for next time
    // metadata: { cursor },
  };
}
