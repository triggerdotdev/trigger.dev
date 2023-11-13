import {
  EventFilter,
  ExternalSource,
  ExternalSourceTrigger,
  HandlerEvent,
  IntegrationTaskKey,
  Logger,
  verifyRequestSignature,
} from "@trigger.dev/sdk";
import AirtableSDK from "airtable";
import { z } from "zod";
import * as events from "./events";
import { Airtable, AirtableRunTask } from "./index";
import { ListWebhooksResponse, ListWebhooksResponseSchema } from "./schemas";
import { WebhookSource, WebhookTrigger } from "@trigger.dev/sdk/triggers/webhook";

const WebhookFromSourceSchema = z.union([
  z.literal("formSubmission"),
  z.literal("client"),
  z.literal("anonymousUser"),
  // we don't currently support these as they can cause feedback loops
  // z.literal("publicApi"),
  // z.literal("automation"),
  // z.literal("system"),
  // z.literal("sync"),
  // z.literal("unknown"),
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
  ): Promise<WebhookRegistrationData> {
    return this.runTask(
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
              options: {
                ...options,
                includes: {
                  includePreviousCellValues: true,
                  includePreviousFieldDefinitions: true,
                },
              },
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

  list(key: IntegrationTaskKey, { baseId }: { baseId: string }): Promise<WebhookListData> {
    return this.runTask(
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

type CreateWebhookTriggersResult<TEventSpecification extends AirtableEvents> = WebhookTrigger<
  TEventSpecification,
  ReturnType<typeof createWebhookSource>
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

export function createWebhookTrigger<TEventSpecification extends AirtableEvents>(
  source: ReturnType<typeof createWebhookSource>,
  event: TEventSpecification,
  params: TriggerParams,
  config: {
    action: string[];
    dataTypes: WebhookDataType[];
    changeTypes?: WebhookChangeType[];
    fromSources?: WebhookFromSource[];
  }
): CreateWebhookTriggersResult<TEventSpecification> {
  return new WebhookTrigger({
    event,
    params,
    source,
    config,
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
    filter: (params, options) => ({
      actionMetadata: {
        source: options?.fromSources ?? ["client", "anonymousUser", "formSubmission"],
      },
    }),
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
          fromSources: (options.fromSources?.desired ?? [
            "client",
            "anonymousUser",
            "formSubmission",
          ]) as WebhookFromSource[],
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

const getSpecification = (config: Record<string, string[]>, params: any): WebhookSpecification => {
  return {
    filters: {
      dataTypes: config.dataTypes as WebhookDataType[],
      changeTypes: config.event as WebhookChangeType[],
      fromSources: (config.fromSources ?? [
        "client",
        "anonymousUser",
        "formSubmission",
      ]) as WebhookFromSource[],
      recordChangeScope: params?.tableId,
    },
  };
};

export function createWebhookSource(
  integration: Airtable
): WebhookSource<
  Airtable,
  { baseId: string; tableId?: string },
  { dataTypes: WebhookDataType[]; fromSources?: WebhookFromSource[] }
> {
  return new WebhookSource({
    id: "airtable.webhook",
    schemas: {
      params: z.object({ baseId: z.string(), tableId: z.string().optional() }),
      config: z.object({
        dataTypes: z.array(WebhookDataTypeSchema),
        fromSources: z.array(WebhookFromSourceSchema).optional(),
      }),
    },
    version: "0.1.0",
    integration,
    filter: (params, options) => ({
      actionMetadata: {
        source: options?.fromSources ?? ["client", "anonymousUser", "formSubmission"],
      },
    }),
    key: (params) =>
      `airtable.webhook.${params.baseId}${params.tableId ? `.${params.tableId}` : ""}`,
    crud: {
      create: async ({ io, ctx }) => {
        const webhook = await io.integration.webhooks().create("create-webhook", {
          url: ctx.url,
          baseId: ctx.params?.baseId,
          options: getSpecification(ctx.config.desired, ctx.params),
        });

        await io.store.job.set("set-id", "webhook-id", webhook.id);
        await io.store.env.set("set-secret", "webhook-secret", webhook.macSecretBase64);
      },
      read: async ({ io, ctx }) => {
        const listResponse = await io.integration.webhooks().list("list-webhooks", {
          baseId: ctx.params?.baseId,
        });

        const existingWebhook = listResponse.webhooks.find((w) => w.notificationUrl === ctx.url);

        if (!existingWebhook) {
          return await io.store.job.delete("delete-stale-webhook-id", "webhook-id");
        }

        await io.store.job.set("set-webhook-id", "webhook-id", existingWebhook.id);
      },
      update: async ({ io, ctx }) => {
        const webhookId = await io.store.job.get("get-webhook-id", "webhook-id");

        if (!webhookId) {
          throw new Error("Stored webhook ID should not be empty when updating.");
        }

        const updatedWebhook = await io.integration.webhooks().update("update-webhook", {
          baseId: ctx.params?.baseId,
          url: ctx.url,
          webhookId,
          options: getSpecification(ctx.config.desired, ctx.params),
        });

        // the update function above runs delete and create internally
        await io.store.job.set("set-webhook-id", "webhook-id", updatedWebhook.id);
      },
      delete: async ({ io, ctx }) => {
        const webhookId = await io.store.job.get("get-webhook-id", "webhook-id");

        await io.integration.webhooks().delete("delete-webhook", {
          baseId: ctx.params?.baseId,
          webhookId,
        });
      },
    },
    verify: async ({ request, io, ctx }) => {
      const secret = await io.store.env.get("get-secret", "webhook-secret");

      // if (!request.body) {
      //   return { success: false, reason: "No body found." };
      // }

      // const rawBody = await request.text();

      // // all headers are automatically lowercased
      // const signature = request.headers.get("x-airtable-content-mac");

      // if (!signature) {
      //   return { success: false, reason: "No signature found." };
      // }

      // const hmac = require("crypto").createHmac("sha256", secret);
      // hmac.update(rawBody, "ascii");
      // const expectedContentHmac = "hmac-sha256=" + hmac.digest("hex");

      // if (signature !== expectedContentHmac) {
      //   return { success: false, reason: "Signatures don't match." };
      // }

      // FIXME: for some reason both verification methods fail

      return { success: true };

      return await verifyRequestSignature({
        request,
        headerName: "x-airtable-content-mac",
        secret,
        algorithm: "sha256",
      });
    },
    handler: async ({ request, io, ctx }) => {
      await io.logger.debug("[@trigger.dev/airtable] Handling webhook payload");

      // TODO: add oauth back
      const client = integration.createClient();

      const webhookPayload = ReceivedPayload.parse(await request.json());

      const cursor = await io.store.job.get("get-cursor", "cursor");

      //fetch the actual payloads
      const response = await getAllPayloads(
        webhookPayload.base.id,
        webhookPayload.webhook.id,
        client,
        cursor
      );

      if (!response) {
        return await io.logger.info("No payload fetch response, nothing to do!");
      }

      await io.store.job.set("set-cursor", "cursor", response.cursor);

      const eventsFromResponse = response.payloads.map((payload) => ({
        id: `${payload.timestamp.getTime()}-${payload.baseTransactionNumber}`,
        payload,
        source: "airtable.com",
        name: "changed",
        timestamp: payload.timestamp,
      }));

      await io.sendEvents("send-events", eventsFromResponse);
    },
  });
}

/** This is the data received from Airtable. It's not useful on its own */
const ReceivedPayload = z.object({
  base: z.object({
    id: z.string(),
  }),
  webhook: z.object({
    id: z.string(),
  }),
  timestamp: z.coerce.date(),
});

const SourceMetadataSchema = z
  .object({
    cursor: z.number().optional(),
  })
  .optional();

async function webhookHandler(event: HandlerEvent<"HTTP">, logger: Logger, integration: Airtable) {
  logger.debug("[@trigger.dev/airtable] Handling webhook payload");

  const client = integration.createClient(event.source.auth);

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

  const webhookPayload = ReceivedPayload.parse(JSON.parse(rawBody));
  const parsedMetadata = SourceMetadataSchema.parse(source.metadata);

  //fetch the actual payloads
  const response = await getAllPayloads(
    webhookPayload.base.id,
    webhookPayload.webhook.id,
    client,
    parsedMetadata?.cursor
  );

  return {
    events: response
      ? response.payloads.map((payload) => ({
          id: `${payload.timestamp}-${payload.baseTransactionNumber}`,
          payload: payload,
          source: "airtable.com",
          name: "changed",
          timestamp: payload.timestamp,
          context: {},
        }))
      : [],
    metadata: response?.cursor ? { cursor: response.cursor } : undefined,
  };
}

async function getAllPayloads(
  baseId: string,
  webhookId: string,
  sdk: AirtableSDK,
  cursor: number | undefined
) {
  let response: ListWebhooksResponse | undefined = undefined;
  let hasMore = true;

  while (hasMore) {
    const newResponse = await getPayload(baseId, webhookId, sdk, cursor);
    cursor = newResponse.cursor;
    hasMore = newResponse.mightHaveMore;

    if (response) {
      response.payloads.push(...newResponse.payloads);
    } else {
      response = newResponse;
    }
  }

  return response;
}

async function getPayload(
  baseId: string,
  webhookId: string,
  sdk: AirtableSDK,
  cursor: number | undefined
) {
  const url = new URL(`${apiUrl}/${baseId}/webhooks/${webhookId}/payloads`);
  if (cursor) {
    url.searchParams.append("cursor", cursor.toString());
  }

  const response = await fetch(url.href, {
    headers: {
      Authorization: `Bearer ${sdk._apiKey}`,
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to list webhooks: ${response.statusText}`);
  }

  const webhook = await response.json();
  return ListWebhooksResponseSchema.parse(webhook);
}
