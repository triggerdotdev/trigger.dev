import { Webhooks } from "@octokit/webhooks";
import { Connection, ExternalSource } from "@trigger.dev/sdk";
import { Octokit } from "octokit";
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

export function repositoryWebhookSource<TEventType>(
  params: {
    repo: string;
    events: string[];
    secret?: string;
  },
  connection: Connection<Octokit, typeof tasks>,
  parsePayload: (payload: any) => TEventType
) {
  // Create a stable key for this source so we only register it once
  const key = `github.repo.${params.repo}.webhook`;

  return new ExternalSource("http", {
    parsePayload,
    connection,
    register: async (io, ctx) => {
      const httpSource = await io.registerHttpSource("register-http-source", {
        key,
      });

      if (
        httpSource.active &&
        webhookData(httpSource.data) &&
        httpSource.secret
      ) {
        const existingData = httpSource.data;

        const sourceEvents = new Set(params.events);
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

      const secret = params.secret || Math.random().toString(36).slice(2);

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
        events: params.events,
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
    handler: async (event, io, ctx) => {
      const deliveryId = event.request.headers["x-github-delivery"];
      const hookId = event.request.headers["x-github-hook-id"];
      const signature = event.request.headers["x-hub-signature-256"];

      if (event.secret && signature) {
        const githubWebhooks = new Webhooks({
          secret: event.secret,
        });

        if (!githubWebhooks.verify(event.request.body, signature)) {
          return {
            events: [],
            response: {
              status: 401,
              body: {
                message: "Invalid signature",
              },
            },
          };
        }
      }

      const name = event.request.headers["x-github-event"];

      const context = omit(event.request.headers, [
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

      const payload = parseBody(event.request.body);

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
        response: {
          status: 200,
          body: {
            ok: true,
          },
        },
      };
    },
  });
}

// Parses the body of a request
// If it's a Buffer, it will be parsed as JSON
function parseBody(body: any) {
  if (Buffer.isBuffer(body)) {
    return JSON.parse(body.toString());
  }

  if (typeof body === "string") {
    return JSON.parse(body);
  }

  return body;
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
