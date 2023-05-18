import { Webhooks } from "@octokit/webhooks";
import {
  IntegrationClient,
  ExternalSource,
  TriggerIntegration,
} from "@trigger.dev/sdk";
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
) {
  return new ExternalSource("HTTP", {
    id: "github.repo",
    version: "0.1.1",
    schema: z.object({ repo: z.string() }),
    integration,
    key: (params) => params.repo,
    filter: (params) => ({
      repository: {
        full_name: [params.repo],
      },
    }),
    handler: async (event, logger) => {
      logger.debug("[inside github integration] Handling github repo event");

      const { rawEvent: request, source } = event;

      if (!request.rawBody) {
        logger.debug("[inside github integration] No rawBody found");

        return;
      }

      const deliveryId = request.headers["x-github-delivery"];
      const hookId = request.headers["x-github-hook-id"];
      const signature = request.headers["x-hub-signature-256"];

      if (source.secret && signature) {
        const githubWebhooks = new Webhooks({
          secret: source.secret,
        });

        if (!githubWebhooks.verify(request.rawBody, signature)) {
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

      const name = request.headers["x-github-event"];

      const context = omit(request.headers, [
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

      const payload = parseBody(request.rawBody);

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
    },
    register: async (event, io, ctx) => {
      const { params, source: httpSource, events, missingEvents } = event;

      if (httpSource.active && webhookData(httpSource.data)) {
        if (missingEvents.length > 0) {
          // We need to update the webhook to add the new events and then return
          const newWebhookData = await io.integration.updateWebhook(
            "update-webhook",
            {
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
) {
  return new ExternalSource("HTTP", {
    id: "github.org",
    version: "0.1.1",
    integration,
    schema: z.object({ org: z.string() }),
    key: (params) => params.org,
    filter: (params) => ({
      organization: {
        login: [params.org],
      },
    }),
    handler: async (event) => {},
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

function safeJsonParse(data: string) {
  try {
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

function omit<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[]
): Omit<T, K> {
  const result: any = {};

  for (const key of Object.keys(obj)) {
    if (!keys.includes(key as K)) {
      result[key] = obj[key];
    }
  }

  return result;
}
