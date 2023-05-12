import { Webhooks } from "@octokit/webhooks";
import { Connection, ExternalSource } from "@trigger.dev/sdk";
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
  connection: Connection<Octokit, typeof tasks>
) {
  return new ExternalSource("http", "0.1.1", {
    schema: z.object({ repo: z.string() }),
    connection,
    register: async (params, spec, io, ctx) => {
      const key = `github.repo.${params.repo}.webhook`;

      const httpSource = await io.registerHttpSource("register-http-source", {
        key,
      });

      if (
        httpSource.active &&
        webhookData(httpSource.data) &&
        httpSource.secret
      ) {
        const existingData = httpSource.data;

        const sourceEvents = new Set([spec.name]);
        const existingEvents = new Set(existingData.events);

        const missingEvents = Array.from(
          new Set(
            Array.from(sourceEvents).filter((x) => !existingEvents.has(x))
          )
        );

        if (missingEvents.length > 0) {
          // We need to update the webhook to add the new events and then return
          const newWebhookData = await io.client.updateWebhook(
            "update-webhook",
            {
              repo: params.repo,
              hookId: existingData.id,
              url: httpSource.url,
              secret: httpSource.secret,
              addEvents: missingEvents,
            }
          );

          await io.updateHttpSource("update-http-source", {
            id: httpSource.id,
            data: newWebhookData,
          });
        }

        return;
      }

      const webhooks = await io.client.listWebhooks("list-webhooks", {
        repo: params.repo,
      });

      const existingWebhook = webhooks.find(
        (w) => w.config.url === httpSource.url
      );

      const secret = Math.random().toString(36).slice(2);

      if (existingWebhook && existingWebhook.active) {
        await io.client.updateWebhook("update-webhook", {
          repo: params.repo,
          hookId: existingWebhook.id,
          url: httpSource.url,
          secret,
        });

        await io.updateHttpSource("update-http-source", {
          id: httpSource.id,
          secret,
          data: existingWebhook,
          active: true,
        });

        return;
      }

      const webhook = await io.client.createWebhook("create-webhook", {
        repo: params.repo,
        events: [spec.name],
        url: httpSource.url,
        secret,
      });

      await io.updateHttpSource("update-http-source", {
        id: httpSource.id,
        secret,
        data: webhook,
        active: true,
      });
    },
    handler: async ({ rawEvent: request, source }, io, ctx) => {
      if (!request.rawBody) {
        return { events: [] };
      }

      const deliveryId = request.headers["x-github-delivery"];
      const hookId = request.headers["x-github-hook-id"];
      const signature = request.headers["x-hub-signature-256"];

      if (source.secret && signature) {
        const githubWebhooks = new Webhooks({
          secret: source.secret,
        });

        if (!githubWebhooks.verify(request.rawBody, signature)) {
          return {
            events: [],
          };
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
        return {
          events: [],
        };
      }

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
  });
}

export function createOrgEventSource(
  connection: Connection<Octokit, typeof tasks>
) {
  return new ExternalSource("http", "0.1.1", {
    schema: z.object({ org: z.string() }),
    connection,
    register: async (params, spec, io, ctx) => {
      const key = `github.org.${params.org}.webhook`;

      const httpSource = await io.registerHttpSource("register-http-source", {
        key,
      });

      if (
        httpSource.active &&
        webhookData(httpSource.data) &&
        httpSource.secret
      ) {
        const existingData = httpSource.data;

        const sourceEvents = new Set([spec.name]);
        const existingEvents = new Set(existingData.events);

        const missingEvents = Array.from(
          new Set(
            Array.from(sourceEvents).filter((x) => !existingEvents.has(x))
          )
        );

        if (missingEvents.length > 0) {
          // We need to update the webhook to add the new events and then return
          const newWebhookData = await io.client.updateOrgWebhook(
            "update-webhook",
            {
              org: params.org,
              hookId: existingData.id,
              url: httpSource.url,
              secret: httpSource.secret,
              addEvents: missingEvents,
            }
          );

          await io.updateHttpSource("update-http-source", {
            id: httpSource.id,
            data: newWebhookData,
          });
        }

        return;
      }

      const webhooks = await io.client.listOrgWebhooks("list-webhooks", {
        org: params.org,
      });

      const existingWebhook = webhooks.find(
        (w) => w.config.url === httpSource.url
      );

      const secret = Math.random().toString(36).slice(2);

      if (existingWebhook && existingWebhook.active) {
        await io.client.updateOrgWebhook("update-webhook", {
          org: params.org,
          hookId: existingWebhook.id,
          url: httpSource.url,
          secret,
        });

        await io.updateHttpSource("update-http-source", {
          id: httpSource.id,
          secret,
          data: existingWebhook,
          active: true,
        });

        return;
      }

      const webhook = await io.client.createOrgWebhook("create-webhook", {
        org: params.org,
        events: [spec.name],
        url: httpSource.url,
        secret,
      });

      await io.updateHttpSource("update-http-source", {
        id: httpSource.id,
        secret,
        data: webhook,
        active: true,
      });
    },
    handler: async ({ rawEvent: request, source }, io, ctx) => {
      if (!request.rawBody) {
        return { events: [] };
      }

      const deliveryId = request.headers["x-github-delivery"];
      const hookId = request.headers["x-github-hook-id"];
      const signature = request.headers["x-hub-signature-256"];

      if (source.secret && signature) {
        const githubWebhooks = new Webhooks({
          secret: source.secret,
        });

        if (!githubWebhooks.verify(request.rawBody, signature)) {
          return {
            events: [],
          };
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
        return {
          events: [],
        };
      }

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
