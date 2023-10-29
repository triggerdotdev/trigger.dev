import {
  EventFilter,
  ExternalSource,
  ExternalSourceTrigger,
  HandlerEvent,
  Logger,
} from "@trigger.dev/sdk";
import { z } from "zod";
import { Vercel } from "./index";
import { WebhookEventSchema } from "./schemas";
import { sha1 } from "./utils";
import {
  CreateDeploymentTriggerResult,
  CreateProjectTriggerResult,
  DeploymentEvents,
  DeploymentTriggerParams,
  ProjectEvents,
  ProjectTriggerParams,
} from "./types";

export function createDeploymentTrigger<TEventSpecification extends DeploymentEvents>(
  source: ReturnType<typeof createDeploymentEventSource>,
  event: TEventSpecification,
  params: DeploymentTriggerParams
): CreateDeploymentTriggerResult<TEventSpecification> {
  return new ExternalSourceTrigger({
    event,
    params,
    source,
    options: {},
  });
}

export function createProjectTrigger<TEventSpecification extends ProjectEvents>(
  source: ReturnType<typeof createProjectEventSource>,
  event: TEventSpecification,
  params: ProjectTriggerParams
): CreateProjectTriggerResult<TEventSpecification> {
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

export function createDeploymentEventSource(
  integration: Vercel
): ExternalSource<Vercel, DeploymentTriggerParams, "HTTP", {}> {
  return new ExternalSource("HTTP", {
    id: "vercel.webhook",
    schema: z.object({
      teamId: z.string(),
      projectIds: z.array(z.string()).optional(),
    }),
    version: "0.1.0",
    integration,
    key: (params) => `${params.teamId}.${params.projectIds ? params.projectIds.join(".") : "all"}`,
    filter: (params) => deploymentFilterFunction(params),
    handler: webhookHandler,
    register: async (event, io, ctx) => {
      const { params, source: httpSource, options } = event;

      if (httpSource.active) {
        const hasMissingOptions = Object.values(options).some(
          (option) => option.missing.length > 0
        );
        if (!hasMissingOptions) return;
      }

      // set of events to register
      const allEvents = Array.from(new Set([...options.event.desired, ...options.event.missing]));
      const registeredOptions = {
        event: allEvents,
      };

      // check for existing hooks that match url
      const listResponse = await io.integration.listWebhooks("list-webhooks", {
        teamId: params.teamId,
      });
      const existingWebhook = listResponse.find((w) => w.url === httpSource.url);

      if (existingWebhook) {
        const updatedWebhook = await io.integration.updateWebhook("update-webhook", {
          webhookId: existingWebhook.id,
          teamId: params.teamId,
          events: allEvents,
          url: httpSource.url,
          projectIds: params.projectIds,
        });

        return {
          data: HttpSourceDataSchema.parse(updatedWebhook),
          secret: updatedWebhook.secret,
          options: registeredOptions,
        };
      }

      const createdWebhook = await io.integration.createWebhook("create-webhook", {
        teamId: params.teamId,
        events: allEvents,
        url: httpSource.url,
        projectIds: params.projectIds,
      });

      return {
        data: HttpSourceDataSchema.parse(createdWebhook),
        secret: createdWebhook.secret,
        options: registeredOptions,
      };
    },
  });
}

export function createProjectEventSource(
  integration: Vercel
): ExternalSource<Vercel, ProjectTriggerParams, "HTTP", {}> {
  return new ExternalSource("HTTP", {
    id: "vercel.webhook",
    schema: z.object({
      teamId: z.string(),
    }),
    version: "0.1.0",
    integration,
    key: (params) => `${params.teamId}.all"}`,
    filter: (params) => ({
      team: {
        id: [params.teamId],
      },
    }),
    handler: webhookHandler,
    register: async (event, io, ctx) => {
      const { params, source: httpSource, options } = event;

      if (httpSource.active) {
        const hasMissingOptions = Object.values(options).some(
          (option) => option.missing.length > 0
        );
        if (!hasMissingOptions) return;
      }

      // set of events to register
      const allEvents = Array.from(new Set([...options.event.desired, ...options.event.missing]));
      const registeredOptions = {
        event: allEvents,
      };

      // check for existing hooks that match url
      const listResponse = await io.integration.listWebhooks("list-webhooks", {
        teamId: params.teamId,
      });
      const existingWebhook = listResponse.find((w) => w.url === httpSource.url);

      if (existingWebhook) {
        const updatedWebhook = await io.integration.updateWebhook("update-webhook", {
          webhookId: existingWebhook.id,
          teamId: params.teamId,
          events: allEvents,
          url: httpSource.url,
        });

        return {
          data: HttpSourceDataSchema.parse(updatedWebhook),
          secret: updatedWebhook.secret,
          options: registeredOptions,
        };
      }

      const createdWebhook = await io.integration.createWebhook("create-webhook", {
        teamId: params.teamId,
        events: allEvents,
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

  if (!request.body) {
    logger.debug("[@trigger.dev/vercel] No body found");
    return { events: [] };
  }

  const vercelSignature = request.headers.get("x-vercel-signature");

  if (!vercelSignature) {
    logger.error("[@trigger.dev/vercel] Error validating webhook signature, no signature found");
    throw Error("[@trigger.dev/vercel] No signature found");
  }

  const rawBody = await request.text();
  const rawBodyBuffer = Buffer.from(rawBody, "utf-8");
  const bodySignature = sha1(rawBodyBuffer, source.secret);

  if (bodySignature !== vercelSignature) {
    logger.error("[@trigger.dev/vercel] Error validating webhook signature, they don't match");
    throw Error("[@trigger.dev/vercel] Invalid signature");
  }

  const body = JSON.parse(rawBody);
  const webhookEvent = WebhookEventSchema.parse(body);

  return {
    events: [
      {
        id: webhookEvent.id,
        name: webhookEvent.type,
        source: "vercel.app",
        payload: webhookEvent.payload,
        context: {},
      },
    ],
  };
}

function deploymentFilterFunction(params: DeploymentTriggerParams): EventFilter {
  const filterObj: EventFilter = {
    team: {
      id: [params.teamId],
    },
  };
  if (params.projectIds) {
    filterObj["project"] = {
      id: params.projectIds,
    };
  }
  return filterObj;
}
