import { safeParseBody } from "@trigger.dev/integration-kit";
import {
  ConnectionAuth,
  EventSpecification,
  ExternalSource,
  ExternalSourceTrigger,
  HandlerEvent,
  IO,
  IOTask,
  IntegrationTaskKey,
  Json,
  Logger,
  RunTaskErrorCallback,
  RunTaskOptions,
  TriggerIntegration,
  retry,
} from "@trigger.dev/sdk";
import { createClient } from "@typeform/api-client";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { SOURCE } from "./consts";
import { Forms } from "./forms";
import { formResponseExample } from "./payload-examples";
import { Responses } from "./responses";
import {
  FormResponseEvent,
  GetWebhookResponse,
  TypeformIntegrationOptions,
  TypeformSDK,
} from "./types";
import { Webhooks } from "./webhooks";

export * from "./types";

type TypeformSource = ReturnType<typeof createWebhookEventSource>;
type TypeformTrigger = ReturnType<typeof createWebhookEventTrigger>;
export type TypeformRunTask = InstanceType<typeof Typeform>["runTask"];

export class Typeform implements TriggerIntegration {
  // @internal
  private _options: TypeformIntegrationOptions;
  // @internal
  private _client?: TypeformSDK;
  // @internal
  private _io?: IO;
  // @internal
  private _connectionKey?: string;

  constructor(private options: TypeformIntegrationOptions) {
    this._options = options;
  }

  get authSource() {
    return "LOCAL" as const;
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "typeform", name: "Typeform" };
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const token = this._options.token ?? auth?.accessToken;

    if (!token) {
      throw new Error(
        `Can't initialize Typeform integration (${this._options.id}) as token was undefined`
      );
    }

    const typeform = new Typeform(this._options);
    typeform._io = io;
    typeform._connectionKey = connectionKey;
    typeform._client = createClient({ token });
    return typeform;
  }

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (client: TypeformSDK, task: IOTask, io: IO) => Promise<TResult>,
    options?: RunTaskOptions,
    errorCallback?: RunTaskErrorCallback
  ): Promise<TResult> {
    if (!this._io) throw new Error("No IO");
    if (!this._connectionKey) throw new Error("No connection key");
    return this._io.runTask(
      key,
      (task, io) => {
        if (!this._client) throw new Error("No client");
        return callback(this._client, task, io);
      },
      {
        icon: "typeform",
        retry: retry.standardBackoff,
        ...(options ?? {}),
        connectionKey: this._connectionKey,
      },
      errorCallback
    );
  }

  get forms() {
    return new Forms(this.runTask.bind(this));
  }

  listForms = this.forms.list;
  getForm = this.forms.get;

  get responses() {
    return new Responses(this.runTask.bind(this));
  }

  listResponses = this.responses.list;

  /** @deprecated this is being replaced by responses.all */
  getAllResponses = this.responses.all.bind(this.responses);

  get webhooks() {
    return new Webhooks(this.runTask.bind(this));
  }

  createWebhook = this.webhooks.create;
  listWebhooks = this.webhooks.list;
  updateWebhook = this.webhooks.update;
  getWebhook = this.webhooks.get;
  deleteWebhook = this.webhooks.delete;

  get source(): TypeformSource {
    return createWebhookEventSource(this);
  }

  get trigger(): TypeformTrigger {
    return createWebhookEventTrigger(this.source);
  }

  onFormResponse(params: { uid: string; tag: string }) {
    return this.trigger({
      event: events.onFormResponse,
      uid: params.uid,
      tag: params.tag,
    });
  }
}

const onFormResponse: EventSpecification<FormResponseEvent> = {
  name: "form_response",
  title: "On issue",
  source: SOURCE,
  icon: "typeform",
  examples: [formResponseExample],
  parsePayload: (payload) => payload as FormResponseEvent,
  runProperties: (payload) => [{ label: "Form ID", text: payload.form_response.form_id }],
};

export const events = {
  onFormResponse,
};

type TypeformEvents = (typeof events)[keyof typeof events];

type CreateTypeformTriggerReturnType = <TEventSpecification extends TypeformEvents>(args: {
  event: TEventSpecification;
  uid: string;
  tag: string;
}) => ExternalSourceTrigger<TEventSpecification, ReturnType<typeof createWebhookEventSource>>;

function createWebhookEventTrigger(
  source: ReturnType<typeof createWebhookEventSource>
): CreateTypeformTriggerReturnType {
  return <TEventSpecification extends TypeformEvents>({
    event,
    uid,
    tag,
  }: {
    event: TEventSpecification;
    uid: string;
    tag: string;
  }) => {
    return new ExternalSourceTrigger({
      event,
      params: { uid, tag },
      source,
      options: {},
    });
  };
}

const WebhookSchema = z.object({
  uid: z.string(),
  tag: z.string(),
});

export function createWebhookEventSource(
  integration: Typeform
): ExternalSource<Typeform, { uid: string; tag: string }, "HTTP", {}> {
  return new ExternalSource("HTTP", {
    id: "typeform.forms",
    schema: WebhookSchema,
    version: "0.1.1",
    integration,
    filter: (params) => {
      return {
        event_type: ["form_response"],
      };
    },
    key: (params) => `${params.uid}/${params.tag}`,
    properties: (params) => [
      {
        label: "Form ID",
        text: params.uid,
      },
      {
        label: "Tag",
        text: params.tag,
      },
    ],
    handler: webhookHandler,
    register: async (event, io, ctx) => {
      const { params, source: httpSource } = event;

      const registeredOptions = {
        event: ["form_response"],
      };

      if (httpSource.active && isWebhookData(httpSource.data) && !httpSource.data.enabled) {
        // Update the webhook to re-enable it
        const newWebhookData = await io.integration.updateWebhook("update-webhook", {
          uid: params.uid,
          tag: params.tag,
          url: httpSource.url,
          enabled: true,
          secret: httpSource.secret,
          verifySSL: true,
        });

        return {
          data: newWebhookData,
          options: registeredOptions,
        };
      }

      const createWebhook = async () => {
        const newWebhookData = await io.integration.createWebhook("create-webhook", {
          uid: params.uid,
          tag: params.tag,
          url: httpSource.url,
          enabled: true,
          secret: httpSource.secret,
          verifySSL: true,
        });

        return {
          data: newWebhookData,
          options: registeredOptions,
        };
      };

      try {
        const existingWebhook = await io.integration.getWebhook("get-webhook", params);

        if (existingWebhook.url !== httpSource.url) {
          return createWebhook();
        }

        if (existingWebhook.enabled) {
          return {
            data: existingWebhook,
            options: registeredOptions,
          };
        }

        const newWebhookData = await io.integration.updateWebhook("update-webhook", {
          uid: params.uid,
          tag: params.tag,
          url: httpSource.url,
          enabled: true,
          secret: httpSource.secret,
          verifySSL: true,
        });

        return {
          data: newWebhookData,
          options: registeredOptions,
        };
      } catch (error) {
        return createWebhook();
      }
    },
  });
}

async function webhookHandler(event: HandlerEvent<"HTTP">, logger: Logger) {
  logger.debug("[inside typeform integration] Handling typeform webhook handler");

  const { rawEvent: request, source } = event;

  if (!request.body) {
    logger.debug("[inside typeform integration] No body found");

    return;
  }

  const rawBody = await request.text();

  const signature = request.headers.get("typeform-signature");

  if (!signature) {
    logger.debug("[inside typeform integration] No signature found");

    return { events: [] };
  }

  const hash = createHmac("sha256", source.secret).update(rawBody).digest("base64");

  const actualSig = `sha256=${hash}`;

  if (signature !== actualSig) {
    logger.debug("[inside typeform integration] Signature does not match, ignoring");

    return { events: [] };
  }

  const payload = safeParseBody(rawBody);

  return {
    events: [
      {
        id: payload.event_id,
        name: payload.event_type,
        source: SOURCE,
        payload,
        context: {},
      },
    ],
  };
}

function isWebhookData(data: any): data is GetWebhookResponse {
  return typeof data === "object" && data !== null && typeof data.id === "string";
}
