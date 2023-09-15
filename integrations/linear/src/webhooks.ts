import {
  ExternalSource,
  ExternalSourceTrigger,
  HandlerEvent,
  IntegrationTaskKey,
  Logger,
} from "@trigger.dev/sdk";
import {
  LinearWebhooks,
  LINEAR_WEBHOOK_SIGNATURE_HEADER,
  LINEAR_WEBHOOK_TS_FIELD,
  WebhookPayload,
  DeletePayload,
  Webhook,
} from "@linear/sdk";
import { z } from "zod";
import * as events from "./events";
import { Linear, LinearRunTask } from "./index";
import {
  WebhookCreateInput,
  WebhookUpdateInput,
  WebhooksQueryVariables,
} from "@linear/sdk/dist/_generated_documents";
import { WebhookPayloadSchema } from "./schemas";

export const WebhookResourceTypeSchema = z.union([
  z.literal("Attachment"),
  z.literal("Comment"),
  z.literal("Cycle"),
  z.literal("Issue"),
  z.literal("IssueLabel"),
  z.literal("Project"),
  z.literal("ProjectUpdate"),
  z.literal("Reaction"),
]);
export type WebhookResourceType = z.infer<typeof WebhookResourceTypeSchema>;

export const WebhookActionTypeSchema = z.union([
  z.literal("create"),
  z.literal("remove"),
  z.literal("update"),
]);
export type WebhookActionType = z.infer<typeof WebhookActionTypeSchema>;

type DeleteWebhookParams = {
  id: string;
};

type UpdateWebhookParams = {
  id: string;
  input: WebhookUpdateInput;
};

// TODO: types
const withoutFunctions = <T>(obj: T): T => {
  return JSON.parse(JSON.stringify(obj), (key, value) => {
    if (typeof value === "function") {
      return undefined;
    }
    return value;
  });
};

export class Webhooks {
  runTask: LinearRunTask;

  constructor(runTask: LinearRunTask) {
    this.runTask = runTask;
  }

  create(
    key: IntegrationTaskKey,
    params: WebhookCreateInput
    // TODO: tidy up return type
  ): Promise<Omit<WebhookPayload, "webhook"> & { webhook: Webhook | undefined }> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const payload = await client.createWebhook(params);
        return withoutFunctions({
          ...payload,
          webhook: await payload.webhook,
        });
      },
      {
        name: "Create webhook",
        params,
      }
    );
  }

  list(key: IntegrationTaskKey, params?: WebhooksQueryVariables): Promise<Webhook[]> {
    return this.runTask(
      key,
      async (client, task, io) => {
        let connections = await client.webhooks(params);
        const hooks = connections.nodes;
        while (connections.pageInfo.hasNextPage) {
          connections = await connections.fetchNext();
          hooks.push(...connections.nodes);
        }
        return withoutFunctions(hooks);
      },
      {
        name: "List webhooks",
        params,
      }
    );
  }

  delete(key: IntegrationTaskKey, params: DeleteWebhookParams): Promise<DeletePayload> {
    return this.runTask(
      key,
      async (client, task, io) => {
        return withoutFunctions(await client.deleteWebhook(params.id));
      },
      {
        name: "Delete webhook",
        params,
      }
    );
  }

  update(
    key: IntegrationTaskKey,
    params: UpdateWebhookParams
  ): Promise<Omit<WebhookPayload, "webhook"> & { webhook: Webhook | undefined }> {
    return this.runTask(
      key,
      async (client, task) => {
        const payload = await client.updateWebhook(params.id, params.input);
        return withoutFunctions({
          ...payload,
          webhook: await payload.webhook,
        });
      },
      {
        name: "Update Webhook",
        params,
      }
    );
  }
}

type LinearEvents = (typeof events)[keyof typeof events];

const TriggerParamsSchema = z.object({
  resourceTypes: z.array(WebhookResourceTypeSchema),
  teamId: z.string().optional(),
  allPublicTeams: z.boolean().optional(),
  actionTypes: z.array(WebhookActionTypeSchema).optional(),
});

export type TriggerParams = z.infer<typeof TriggerParamsSchema>;

type CreateTriggersResult<TEventSpecification extends LinearEvents> = ExternalSourceTrigger<
  TEventSpecification,
  ReturnType<typeof createWebhookEventSource>
>;

export function createTrigger<TEventSpecification extends LinearEvents>(
  source: ReturnType<typeof createWebhookEventSource>,
  event: TEventSpecification,
  params: TriggerParams
  // options: {
  //   actionTypes?: WebhookActionType[]; // via params
  // }
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
type WebhookRegistrationData = z.infer<typeof WebhookRegistrationDataSchema>;

export function createWebhookEventSource(
  integration: Linear
): ExternalSource<Linear, TriggerParams, "HTTP", {}> {
  return new ExternalSource("HTTP", {
    id: "linear.webhook",
    schema: TriggerParamsSchema,
    // optionSchema: z.object({ }),
    version: "0.1.0",
    integration,
    // TODO: filter by actionTypes
    // filter: (params, options) => ({ }),
    key: (params) => `${params.teamId ? params.teamId : "all"}`,
    handler: webhookHandler,
    register: async (event, io, ctx) => {
      const { params, source: httpSource, options } = event;

      // (key-specific) stored data, undefined if not registered yet
      const webhookData = WebhookRegistrationDataSchema.safeParse(httpSource.data);

      console.log(webhookData);
      if (!webhookData.success) {
        console.log(webhookData.error);
      }

      // set of events to register
      const allEvents = Array.from(new Set([...options.event.desired, ...options.event.missing]));
      const registeredOptions = {
        event: allEvents,
      };

      // easily identify webhooks on linear
      const label = `trigger.${params.teamId ? params.teamId : "all"}`;

      // TODO: remove tunnel
      const url = process.env["DEV_TUNNEL"]
        ? httpSource.url.replace("http://localhost:3030", process.env["DEV_TUNNEL"])
        : httpSource.url;

      if (httpSource.active && webhookData.success) {
        const hasMissingOptions = Object.values(options).some(
          (option) => option.missing.length > 0
        );
        if (!hasMissingOptions) return;

        const updatedWebhook = await io.integration.webhooks().update("update-webhook", {
          id: webhookData.data.webhook.id,
          input: {
            label,
            resourceTypes: allEvents,
            secret: httpSource.secret,
            url,
          },
        });

        return {
          data: WebhookRegistrationDataSchema.parse(updatedWebhook),
          options: registeredOptions,
        };
      }

      // check for existing hooks that match url
      const listResponse = await io.integration.webhooks().list("list-webhooks");
      const existingWebhook = listResponse.find((w) => w.url === url);

      if (existingWebhook) {
        const updatedWebhook = await io.integration.webhooks().update("update-webhook", {
          id: existingWebhook.id,
          input: {
            label,
            resourceTypes: allEvents,
            secret: httpSource.secret,
            url,
          },
        });

        return {
          data: WebhookRegistrationDataSchema.parse(updatedWebhook),
          options: registeredOptions,
        };
      }

      const createPayload = await io.integration.webhooks().create("create-webhook", {
        allPublicTeams: !params.teamId,
        label,
        resourceTypes: allEvents,
        secret: httpSource.secret,
        teamId: params.teamId,
        url,
      });

      // TODO
      // if(!createPayload.success)

      return {
        data: WebhookRegistrationDataSchema.parse(createPayload),
        secret: (await createPayload.webhook)?.secret,
        options: registeredOptions,
      };
    },
  });
}

// TODO
const SourceMetadataSchema = z.object({}).optional();

async function webhookHandler(event: HandlerEvent<"HTTP">, logger: Logger, integration: Linear) {
  logger.debug("[@trigger.dev/linear] Handling webhook payload");

  const { rawEvent: request, source } = event;

  const LINEAR_IPS = ["35.231.147.226", "35.243.134.228"];

  // TODO: remove tunnel
  if (!process.env["DEV_TUNNEL"] && !LINEAR_IPS.includes(request.headers.get("Host") ?? "")) {
    logger.error("[@trigger.dev/linear] Error validating webhook source, IP invalid.");
    throw Error("[@trigger.dev/linear] Invalid source IP.");
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
  const webhook = new LinearWebhooks(source.secret);

  // TODO: might want to do two passes, with and without timestamp (delay parsing)
  if (!webhook.verify(Buffer.from(rawBody), signature, body[LINEAR_WEBHOOK_TS_FIELD])) {
    logger.error("[@trigger.dev/linear] Error validating webhook signature, they don't match");
    throw Error("[@trigger.dev/linear] Invalid signature");
  }

  const webhookPayload = WebhookPayloadSchema.parse(body);
  const parsedMetadata = SourceMetadataSchema.parse(source.metadata);

  return {
    events: [
      {
        id: webhookPayload.webhookId,
        name: webhookPayload.webhookTimestamp.toISOString(),
        source: "linear.app",
        payload: webhookPayload,
        context: {},
      },
    ],
    metadata: parsedMetadata,
  };
}
