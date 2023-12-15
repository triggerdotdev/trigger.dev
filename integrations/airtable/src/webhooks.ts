import { EventFilter, IntegrationTaskKey, verifyRequestSignature } from "@trigger.dev/sdk";
import AirtableSDK from "airtable";
import { z } from "zod";
import * as events from "./events";
import { Airtable, AirtableRunTask } from "./index";
import { ListWebhooksResponse, ListWebhooksResponseSchema } from "./schemas";
import { WebhookSource, WebhookTrigger } from "@trigger.dev/sdk";
import { registerJobNamespace } from "@trigger.dev/integration-kit";
import { Buffer } from "node:buffer";

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

const AirtableErrorBodySchema = z
  .union([
    z.object({
      error: z.string(),
    }),
    z.object({
      error: z.object({
        type: z.string(),
        message: z.string().optional(),
      }),
    }),
  ])
  .transform((body) => {
    if (typeof body.error === "string") {
      return {
        type: body.error,
      };
    } else {
      return {
        type: body.error.type,
        message: body.error.message,
      };
    }
  });

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
          await handleWebhookError(response, "WEBHOOK_CREATE");
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
        const response = await fetch(`${apiUrl}/${baseId}/webhooks`, {
          headers: {
            Authorization: `Bearer ${client._apiKey}`,
          },
          redirect: "follow",
        });

        if (!response.ok) {
          await handleWebhookError(response, "WEBHOOK_LIST");
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
        const response = await fetch(`${apiUrl}/${baseId}/webhooks/${webhookId}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${client._apiKey}`,
          },
          redirect: "follow",
        });

        if (!response.ok) {
          await handleWebhookError(response, "WEBHOOK_DELETE");
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

type CreateWebhookTriggersResult<TEventSpecification extends AirtableEvents> = WebhookTrigger<
  TEventSpecification,
  ReturnType<typeof createWebhookSource>
>;

export function createWebhookTrigger<TEventSpecification extends AirtableEvents>(
  source: ReturnType<typeof createWebhookSource>,
  event: TEventSpecification,
  params: TriggerParams,
  config: {
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

const getSpecification = (config: Record<string, string[]>, params: any): WebhookSpecification => {
  return {
    filters: {
      dataTypes: config.dataTypes as WebhookDataType[],
      changeTypes: config.changeTypes
        ? (config.changeTypes as WebhookChangeType[])
        : ["add", "remove", "update"],
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
        await io.store.job.set("set-secret", "webhook-secret-base64", webhook.macSecretBase64);
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
      delete: async ({ io, ctx }) => {
        const webhookId = await io.store.job.get<string>("get-webhook-id", "webhook-id");

        if (!webhookId) {
          throw new Error("Missing webhook ID for delete operation.");
        }

        await io.integration.webhooks().delete("delete-webhook", {
          baseId: ctx.params?.baseId,
          webhookId,
        });
      },
    },
    verify: async ({ request, client, ctx }) => {
      // TODO: should pass namespaced store instead, e.g. client.store.webhookRegistration.get()
      const secretBase64 = await client.store.env.get<string>(
        `${registerJobNamespace(ctx.key)}:webhook-secret-base64`
      );

      if (!secretBase64) {
        throw new Error("Missing secret for verification.");
      }

      return await verifyRequestSignature({
        request,
        headerName: "x-airtable-content-mac",
        secret: Buffer.from(secretBase64, "base64"),
        algorithm: "sha256",
      });
    },
    generateEvents: async ({ request, client, ctx }) => {
      console.log("[@trigger.dev/airtable] Handling webhook payload");

      const webhookPayload = ReceivedPayload.parse(await request.json());

      const webhookId = await client.store.env.get<string>(
        `${registerJobNamespace(ctx.key)}:webhook-id`
      );

      const cursorKey = `cursor-${webhookId}`;
      const cursor = await client.store.env.get<number>(cursorKey);

      // TODO: get auth back
      const airtable = integration.createClient();

      const response = await getAllPayloads(
        webhookPayload.base.id,
        webhookPayload.webhook.id,
        airtable,
        cursor
      );

      if (!response) {
        return console.log("[@trigger.dev/airtable] No payload fetch response, nothing to do!");
      }

      await client.store.env.set(cursorKey, response.cursor);

      const eventsFromResponse = response.payloads.map((payload) => ({
        id: `${payload.timestamp.getTime()}-${payload.baseTransactionNumber}`,
        payload,
        source: "airtable.com",
        name: "changed",
        timestamp: payload.timestamp,
      }));

      await client.sendEvents(eventsFromResponse);
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

async function handleWebhookError(response: Response, errorType: string) {
  const rawErrorBody = await response.json();

  const parsedErrorBody = AirtableErrorBodySchema.safeParse(rawErrorBody);

  if (!parsedErrorBody.success) {
    throw new AirtableSDK.Error(
      `${errorType}_PARSE_ERROR`,
      `${response.statusText}:\n${rawErrorBody}`,
      response.status
    );
  }

  const { type, message } = parsedErrorBody.data;

  throw new AirtableSDK.Error(type, message ?? response.statusText, response.status);
}
