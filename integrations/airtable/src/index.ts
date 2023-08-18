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
} from "@trigger.dev/sdk";
import AirtableSDK from "airtable";
import events from "events";
import z from "zod";
import { Base } from "./base";

export * from "./types";

export type AirtableIntegrationOptions = {
  /** An ID for this client  */
  id: string;
  /** Use this if you pass in a [Personal Access Token](https://airtable.com/developers/web/guides/personal-access-tokens). If omitted, it will use OAuth.  */
  token?: string;
};

export type AirtableRunTask = InstanceType<typeof Airtable>["runTask"];

const apiUrl = "https://api.airtable.com/v0/bases";

export class Airtable implements TriggerIntegration {
  private _options: AirtableIntegrationOptions;
  private _client?: AirtableSDK;
  private _io?: IO;

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

  // get source() {
  //   return createWebhookEventSource(this);
  // }

  cloneForRun(io: IO, auth?: ConnectionAuth) {
    const airtable = new Airtable(this._options);
    airtable._io = io;
    if (auth) {
      airtable._client = new AirtableSDK({
        apiKey: auth.accessToken,
      });
    }

    if (this._options.token) {
      airtable._client = new AirtableSDK({
        apiKey: this._options.token,
      });
    }

    return airtable;
  }

  runTask<TResult extends RunTaskResult = void>(
    key: IntegrationTaskKey,
    callback: (client: AirtableSDK, task: IOTask, io: IO) => Promise<TResult>,
    options?: RunTaskOptions,
    errorCallback?: RunTaskErrorCallback
  ) {
    if (!this._io) throw new Error("No IO");

    return this._io.runTask<TResult>(
      key,
      (task, io) => {
        if (!this._client) throw new Error("No client");
        return callback(this._client, task, io);
      },
      { icon: "airtable", ...(options ?? {}), connectionKey: this.id },
      errorCallback
    );
  }

  base(baseId: string) {
    return new Base(this.runTask.bind(this), baseId);
  }

  createWebhook(key: IntegrationTaskKey, { baseId, url }: { baseId: string; url: string }) {
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
            options: {
              filters: {
                dataTypes: ["tableData"],
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
}

type StripeEvents = (typeof events)[keyof typeof events];

// function createTrigger<TEventSpecification extends StripeEvents>(
//   source: ReturnType<typeof createWebhookEventSource>,
//   event: TEventSpecification,
//   params: TriggerParams
// ): CreateTriggersResult<TEventSpecification> {
//   return new ExternalSourceTrigger({
//     event,
//     params,
//     source,
//   });
// }

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
      expirationTime: z.date(),
      areNotificationsEnabled: z.boolean(),
      isHookEnabled: z.boolean(),
    })
  ),
});

type WebhookListData = z.infer<typeof WebhookListDataSchema>;

// function createWebhookEventSource(
//   integration: Airtable
// ): ExternalSource<Airtable, { baseId: string }, "HTTP"> {
//   return new ExternalSource("HTTP", {
//     id: "airtable.webhook",
//     schema: z.object({ baseId: z.string() }),
//     version: "0.1.0",
//     integration,
//     key: (params) => `airtable.webhook.${params.baseId}`,
//     handler: webhookHandler,
//     register: async (event, io, ctx) => {
//       const { params, source: httpSource, events, missingEvents } = event;

//       const webhookData = WebhookRegistrationDataSchema.safeParse(httpSource.data);

//       const allEvents = Array.from(new Set([...events, ...missingEvents]));

//       if (httpSource.active && webhookData.success) {
//         if (missingEvents.length === 0) return;

//         //todo delete and recreate
//         const updatedWebhook = await io.integration.updateWebhook("update-webhook", {
//           id: webhookData.data.id,
//           url: httpSource.url,
//           enabled_events: allEvents as unknown as WebhookEvents[],
//         });

//         return {
//           data: WebhookRegistrationDataSchema.parse(updatedWebhook),
//           registeredEvents: allEvents,
//         };
//       }

//       const listResponse = await io.integration.listWebhooks("list-webhooks", {
//         baseId: params.baseId,
//       });

//       const existingWebhook = listResponse.webhooks.find(
//         (w) => w.notificationUrl === httpSource.url
//       );

//       if (existingWebhook) {
//         const updatedWebhook = await io.integration.updateWebhook("update-found-webhook", {
//           id: existingWebhook.id,
//           url: httpSource.url,
//           enabled_events: allEvents as unknown as WebhookEvents[],
//           disabled: false,
//         });

//         return {
//           data: WebhookRegistrationDataSchema.parse(updatedWebhook),
//           registeredEvents: allEvents,
//         };
//       }

//       const webhook = await io.integration.createWebhook("create-webhook", {
//         url: httpSource.url,
//         baseId: params.baseId,
//       });

//       return {
//         data: WebhookRegistrationDataSchema.parse(webhook),
//         secret: webhook.macSecretBase64,
//         registeredEvents: allEvents,
//       };
//     },
//   });
// }
