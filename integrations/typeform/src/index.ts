import { createClient } from "@typeform/api-client";
import * as tasks from "./tasks";

import {
  FormResponseEvent,
  GetWebhookResponse,
  TypeformIntegrationOptions,
  TypeformSDK,
} from "./types";
import {
  TriggerIntegration,
  IntegrationClient,
  ExternalSource,
  HandlerEvent,
  Logger,
  ExternalSourceTrigger,
  EventSpecification,
} from "@trigger.dev/sdk";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { formResponseExample } from "./payload-examples";
import { safeParseBody } from "@trigger.dev/integration-kit";
import { SOURCE } from "./consts";

export * from "./types";

type TypeformIntegration = TriggerIntegration<TypeformIntegrationClient>;
type TypeformIntegrationClient = IntegrationClient<TypeformSDK, typeof tasks>;

type TypeformSource = ReturnType<typeof createWebhookEventSource>;
type TypeformTrigger = ReturnType<typeof createWebhookEventTrigger>;

export class Typeform implements TypeformIntegration {
  client: TypeformIntegrationClient;

  constructor(private options: TypeformIntegrationOptions) {
    if (Object.keys(options).includes("token") && !options.token) {
      throw `Can't create Typeform integration (${options.id}) as token was undefined`;
    }

    this.client = {
      tasks,
      usesLocalAuth: true,
      client: createClient({ token: options.token }),
      auth: {
        token: options.token,
        apiBaseUrl: options.apiBaseUrl,
      },
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "typeform", name: "Typeform" };
  }

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
  runProperties: (payload) => [
    { label: "Form ID", text: payload.form_response.form_id },
  ],
};

export const events = {
  onFormResponse,
};

type TypeformEvents = (typeof events)[keyof typeof events];

type CreateTypeformTriggerReturnType = <
  TEventSpecification extends TypeformEvents
>(args: {
  event: TEventSpecification;
  uid: string;
  tag: string;
}) => ExternalSourceTrigger<
  TEventSpecification,
  ReturnType<typeof createWebhookEventSource>
>;

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
    });
  };
}

const WebhookSchema = z.object({
  uid: z.string(),
  tag: z.string(),
});

export function createWebhookEventSource(
  integration: TypeformIntegration
): ExternalSource<TypeformIntegration, { uid: string; tag: string }, "HTTP"> {
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

      if (
        httpSource.active &&
        isWebhookData(httpSource.data) &&
        !httpSource.data.enabled
      ) {
        // Update the webhook to re-enable it
        const newWebhookData = await io.integration.updateWebhook(
          "update-webhook",
          {
            uid: params.uid,
            tag: params.tag,
            url: httpSource.url,
            enabled: true,
            secret: httpSource.secret,
            verifySSL: true,
          }
        );

        return {
          data: newWebhookData,
          registeredEvents: ["form_response"],
        };
      }

      const createWebhook = async () => {
        const newWebhookData = await io.integration.createWebhook(
          "create-webhook",
          {
            uid: params.uid,
            tag: params.tag,
            url: httpSource.url,
            enabled: true,
            secret: httpSource.secret,
            verifySSL: true,
          }
        );

        return {
          data: newWebhookData,
          registeredEvents: ["form_response"],
        };
      };

      try {
        const existingWebhook = await io.integration.getWebhook(
          "get-webhook",
          params
        );

        if (existingWebhook.url !== httpSource.url) {
          return createWebhook();
        }

        if (existingWebhook.enabled) {
          return {
            data: existingWebhook,
            registeredEvents: ["form_response"],
          };
        }

        const newWebhookData = await io.integration.updateWebhook(
          "update-webhook",
          {
            uid: params.uid,
            tag: params.tag,
            url: httpSource.url,
            enabled: true,
            secret: httpSource.secret,
            verifySSL: true,
          }
        );

        return {
          data: newWebhookData,
          registeredEvents: ["form_response"],
        };
      } catch (error) {
        return createWebhook();
      }
    },
  });
}

async function webhookHandler(event: HandlerEvent<"HTTP">, logger: Logger) {
  logger.debug(
    "[inside typeform integration] Handling typeform webhook handler"
  );

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

  const hash = createHmac("sha256", source.secret)
    .update(rawBody)
    .digest("base64");

  const actualSig = `sha256=${hash}`;

  if (signature !== actualSig) {
    logger.debug(
      "[inside typeform integration] Signature does not match, ignoring"
    );

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
  return (
    typeof data === "object" && data !== null && typeof data.id === "string"
  );
}
