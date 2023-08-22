import { Prettify } from "@trigger.dev/integration-kit";
import {
  ExternalSource,
  type ConnectionAuth,
  type IO,
  type IOTask,
  type IntegrationTaskKey,
  type RunTaskErrorCallback,
  type RunTaskOptions,
  type RunTaskResult,
  type TriggerIntegration,
  HandlerEvent,
  Logger,
  ExternalSourceTrigger,
  EventFilter,
} from "@trigger.dev/sdk";
import AirtableSDK from "airtable";
import z from "zod";
import { Base } from "./base";
import * as events from "./events";

export * from "./types";

export type AirtableIntegrationOptions = {
  /** An ID for this client  */
  id: string;
  /** Use this if you pass in a [Personal Access Token](https://airtable.com/developers/web/guides/personal-access-tokens). If omitted, it will use OAuth.  */
  token?: string;
};

export type AirtableRunTask = InstanceType<typeof Airtable>["runTask"];

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
type WebhookDataType = z.infer<typeof WebhookDataTypeSchema>;
const WebhookChangeTypeSchema = z.union([
  z.literal("add"),
  z.literal("remove"),
  z.literal("update"),
]);
type WebhookChangeType = z.infer<typeof WebhookChangeTypeSchema>;
type WebhookSpecification = {
  filters: {
    dataTypes: WebhookDataType[];
    recordChangeScope?: string;
    changeTypes?: WebhookChangeType[];
    fromSources?: WebhookFromSource[];
  };
};

const apiUrl = "https://api.airtable.com/v0/bases";

export class Airtable implements TriggerIntegration {
  private _options: AirtableIntegrationOptions;
  private _client?: AirtableSDK;
  private _io?: IO;
  private _connectionKey?: string;

  constructor(options: Prettify<AirtableIntegrationOptions>) {
    if (Object.keys(options).includes("token") && !options.token) {
      throw `Can't create Airtable integration (${options.id}) as token was passed in but undefined`;
    }

    this._options = options;
  }

  get authSource() {
    return this._options.token ? ("LOCAL" as const) : ("HOSTED" as const);
  }

  get id() {
    return this._options.id;
  }

  get metadata() {
    return { id: "airtable", name: "Airtable" };
  }

  get source() {
    return createWebhookEventSource(this);
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const airtable = new Airtable(this._options);
    airtable._io = io;
    airtable._connectionKey = connectionKey;
    if (auth) {
      airtable._client = new AirtableSDK({
        apiKey: auth.accessToken,
      });
      return airtable;
    }

    if (this._options.token) {
      airtable._client = new AirtableSDK({
        apiKey: this._options.token,
      });
      return airtable;
    }

    throw new Error("No auth");
  }

  runTask<TResult extends RunTaskResult = void>(
    key: IntegrationTaskKey,
    callback: (client: AirtableSDK, task: IOTask, io: IO) => Promise<TResult>,
    options?: RunTaskOptions,
    errorCallback?: RunTaskErrorCallback
  ) {
    if (!this._io) throw new Error("No IO");
    if (!this._connectionKey) throw new Error("No connection key");

    return this._io.runTask<TResult>(
      key,
      (task, io) => {
        if (!this._client) throw new Error("No client");
        return callback(this._client, task, io);
      },
      { icon: "airtable", ...(options ?? {}), connectionKey: this._connectionKey },
      errorCallback
    );
  }

  base(baseId: string) {
    return new Base(this.runTask.bind(this), baseId);
  }

  onTable(params: { baseId: string; tableId: string; changes?: WebhookChangeType[] }) {
    return createTrigger(this.source, events.onTableChanged, params);
  }

  //todo add support for dataTypes, changeTypes and fromSources
  createWebhook(
    key: IntegrationTaskKey,
    { baseId, url, options }: { baseId: string; url: string; options: WebhookSpecification }
  ) {
    return this.runTask<WebhookRegistrationData>(key, async (client, task, io) => {
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
    });
  }

  listWebhooks(key: IntegrationTaskKey, { baseId }: { baseId: string }) {
    return this.runTask<WebhookListData>(key, async (client, task, io) => {
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
    });
  }

  deleteWebhook(
    key: IntegrationTaskKey,
    { baseId, webhookId }: { baseId: string; webhookId: string }
  ) {
    return this.runTask(key, async (client, task, io) => {
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
    });
  }

  async updateWebhook(
    key: IntegrationTaskKey,
    {
      baseId,
      url,
      webhookId,
      options,
    }: { baseId: string; url: string; webhookId: string; options: WebhookSpecification }
  ) {
    await this.deleteWebhook(`${key}-delete`, { baseId, webhookId });
    return await this.createWebhook(`${key}-create`, { baseId, url, options });
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

function createTrigger<TEventSpecification extends AirtableEvents>(
  source: ReturnType<typeof createWebhookEventSource>,
  event: TEventSpecification,
  params: TriggerParams,
  options: TriggerOptions
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

function createWebhookEventSource(
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
    //todo update this to take options as well
    filter: (params) => {
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

        const updatedWebhook = await io.integration.updateWebhook("update-webhook", {
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

      const listResponse = await io.integration.listWebhooks("list-webhooks", {
        baseId: params.baseId,
      });

      const existingWebhook = listResponse.webhooks.find(
        (w) => w.notificationUrl === httpSource.url
      );

      if (existingWebhook) {
        const updatedWebhook = await io.integration.updateWebhook("update-webhook", {
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

      const webhook = await io.integration.createWebhook("create-webhook", {
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

  // const event = stripeClient.webhooks.constructEvent(rawBody, signature, source.secret);

  return {
    events: [
      {
        //todo this all needs updating, to be the data fetched from the list payloads endpoint
        id: payload.base.id,
        payload: payload,
        source: "airtable.com",
        name: "an event that needs updating",
        timestamp: payload.timestamp,
        context: {},
      },
    ],
  };
}
