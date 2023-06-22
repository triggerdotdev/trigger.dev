import { Webhooks } from "@octokit/webhooks";
import {
  IntegrationClient,
  ExternalSource,
  TriggerIntegration,
  HandlerEvent,
} from "@trigger.dev/sdk";
import type { Logger } from "@trigger.dev/sdk";
import { safeJsonParse, omit } from "@trigger.dev/integration-kit";
import { Octokit } from "octokit";
import { z } from "zod";
import { tasks } from "./tasks";

type WebhookData = {
  id: number;
  active: boolean;
  events: string[];
  config: {
    url: string;
  };
};

function webhookData(data: any): data is WebhookData {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof data.id === "number" &&
    typeof data.config === "object"
  );
}

export function createRepoEventSource(
  integration: TriggerIntegration<IntegrationClient<Octokit, typeof tasks>>
): ExternalSource<
  TriggerIntegration<IntegrationClient<Octokit, typeof tasks>>,
  { owner: string; repo: string },
  "HTTP"
> {
  return new ExternalSource("HTTP", {
    id: "github.repo",
    version: "0.1.1",
    schema: z.object({ owner: z.string(), repo: z.string() }),
    integration,
    key: (params) => `${params.owner}/${params.repo}`,
    properties: (params) => [
      {
        label: "Owner",
        text: params.owner,
        url: `https://github.com/${params.owner}`,
      },
      {
        label: "Repo",
        text: params.repo,
        url: `https://github.com/${params.owner}/${params.repo}`,
      },
    ],
    filter: (params) => ({
      repository: {
        full_name: [`${params.owner}/${params.repo}`],
      },
    }),
    handler: webhookHandler,
    register: async (event, io, ctx) => {
      const { params, source: httpSource, events, missingEvents } = event;

      if (httpSource.active && webhookData(httpSource.data)) {
        if (missingEvents.length > 0) {
          // We need to update the webhook to add the new events and then return
          const newWebhookData = await io.integration.updateWebhook(
            "update-webhook",
            {
              owner: params.owner,
              repo: params.repo,
              hookId: httpSource.data.id,
              url: httpSource.url,
              secret: httpSource.secret,
              addEvents: missingEvents,
            }
          );

          return {
            data: newWebhookData,
            registeredEvents: newWebhookData.events,
          };
        }

        return;
      }

      const webhooks = await io.integration.listWebhooks("list-webhooks", {
        owner: params.owner,
        repo: params.repo,
      });

      const existingWebhook = webhooks.find(
        (w) => w.config.url === httpSource.url
      );

      // There is an existing webhook, but it's not synced with Trigger.dev, so we need to update it with the secret
      if (existingWebhook && existingWebhook.active) {
        const updatedWebhook = await io.integration.updateWebhook(
          "update-webhook",
          {
            owner: params.owner,
            repo: params.repo,
            hookId: existingWebhook.id,
            url: httpSource.url,
            secret: httpSource.secret,
            addEvents: missingEvents,
          }
        );

        return {
          data: updatedWebhook,
          registeredEvents: updatedWebhook.events,
        };
      }

      const webhook = await io.integration.createWebhook("create-webhook", {
        owner: params.owner,
        repo: params.repo,
        events,
        url: httpSource.url,
        secret: httpSource.secret,
      });

      return { data: webhook, registeredEvents: webhook.events };
    },
  });
}

export function createOrgEventSource(
  integration: TriggerIntegration<IntegrationClient<Octokit, typeof tasks>>
): ExternalSource<
  TriggerIntegration<IntegrationClient<Octokit, typeof tasks>>,
  { org: string },
  "HTTP"
> {
  return new ExternalSource("HTTP", {
    id: "github.org",
    version: "0.1.1",
    integration,
    schema: z.object({ org: z.string() }),
    key: (params) => params.org,
    properties: (params) => [
      {
        label: "Org",
        text: params.org,
        url: `https://github.com/${params.org}`,
      },
    ],
    filter: (params) => ({
      organization: {
        login: [params.org],
      },
    }),
    handler: webhookHandler,
    register: async (event, io, ctx) => {
      const { params, source: httpSource, events, missingEvents } = event;

      if (
        httpSource.active &&
        webhookData(httpSource.data) &&
        httpSource.secret &&
        missingEvents.length > 0
      ) {
        const existingData = httpSource.data;

        // We need to update the webhook to add the new events and then return
        const newWebhookData = await io.integration.updateOrgWebhook(
          "update-webhook",
          {
            org: params.org,
            hookId: existingData.id,
            url: httpSource.url,
            secret: httpSource.secret,
            addEvents: missingEvents,
          }
        );

        return {
          secret: httpSource.secret,
          data: newWebhookData,
          registeredEvents: newWebhookData.events,
        };
      }

      const webhooks = await io.integration.listOrgWebhooks("list-webhooks", {
        org: params.org,
      });

      const existingWebhook = webhooks.find(
        (w) => w.config.url === httpSource.url
      );

      const secret = Math.random().toString(36).slice(2);

      if (existingWebhook && existingWebhook.active) {
        const updatedWebhook = await io.integration.updateOrgWebhook(
          "update-webhook",
          {
            org: params.org,
            hookId: existingWebhook.id,
            url: httpSource.url,
            secret,
          }
        );

        return {
          secret,
          data: updatedWebhook,
          registeredEvents: updatedWebhook.events,
        };
      }

      const webhook = await io.integration.createOrgWebhook("create-webhook", {
        org: params.org,
        events,
        url: httpSource.url,
        secret,
      });

      return { secret, data: webhook, registeredEvents: webhook.events };
    },
  });
}

// Parses the body of a request
// If it's a Buffer, it will be parsed as JSON
function parseBody(body: any) {
  if (Buffer.isBuffer(body)) {
    return safeJsonParse(body.toString());
  }

  if (typeof body === "string") {
    return safeJsonParse(body);
  }

  return body;
}

async function webhookHandler(event: HandlerEvent<"HTTP">, logger: Logger) {
  logger.debug("[inside github integration] Handling github repo event");

  const { rawEvent: request, source } = event;

  if (!request.body) {
    logger.debug("[inside github integration] No body found");

    return;
  }

  const rawBody = await request.text();

  const deliveryId = request.headers.get("x-github-delivery");
  const hookId = request.headers.get("x-github-hook-id");
  const signature = request.headers.get("x-hub-signature-256");

  if (source.secret && signature) {
    const githubWebhooks = new Webhooks({
      secret: source.secret,
    });

    if (!githubWebhooks.verify(rawBody, signature)) {
      logger.debug(
        "[inside github integration] Unable to verify the signature of the rawBody",
        {
          signature,
          secret: source.secret,
        }
      );

      return;
    }
  }

  const name = request.headers.get("x-github-event") ?? "unknown";
  const allHeaders = Object.fromEntries(request.headers.entries());

  const context = omit(allHeaders, [
    "x-github-event",
    "x-github-delivery",
    "x-hub-signature-256",
    "x-hub-signature",
    "content-type",
    "content-length",
    "accept",
    "accept-encoding",
    "x-forwarded-proto",
  ]);

  const payload = parseBody(rawBody);

  if (!payload) {
    logger.debug("[inside github integration] Unable to parse the rawBody");

    return;
  }

  logger.debug(
    "[inside github integration] Returning an event for the webhook!",
    {
      name,
      payload,
      context,
    }
  );

  return {
    events: [
      {
        id: [hookId, deliveryId].join(":"),
        source: "github.com",
        payload,
        name,
        context,
      },
    ],
  };
}
