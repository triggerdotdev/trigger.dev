import { Webhooks } from "@octokit/webhooks";
import { ExternalSource } from "@trigger.dev/sdk/externalSource";
import { Octokit } from "octokit";
import { metadata } from "./metadata";

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

export function repositoryWebhookSource(
  params: {
    repo: string;
    events: string[];
    secret?: string;
  },
  client: Octokit
) {
  // Create a stable key for this source so we only register it once
  const key = `github.repo.${params.repo}.webhook`;

  return new ExternalSource("http", metadata, {
    usesLocalAuth: true,
    key,
    register: async (triggerClient, auth) => {
      if (!auth) {
        throw new Error("No auth provided");
      }

      const httpSource = await triggerClient.registerHttpSource({
        key,
      });

      const [owner, repo] = params.repo.split("/");

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
          const { data: newWebhookData } =
            await client.rest.repos.updateWebhook({
              owner,
              repo,
              hook_id: existingData.id,
              config: {
                content_type: "json",
                url: httpSource.url,
                secret: httpSource.secret,
              },
              add_events: missingEvents,
            });

          await triggerClient.updateHttpSource(httpSource.id, {
            data: newWebhookData,
          });
        }

        return;
      }

      const { data: webhooks } = await client.rest.repos.listWebhooks({
        owner,
        repo,
      });

      const existingWebhook = webhooks.find(
        (w) => w.config.url === httpSource.url
      );

      const secret = params.secret || Math.random().toString(36).slice(2);

      if (existingWebhook && existingWebhook.active) {
        await client.rest.repos.updateWebhook({
          owner,
          repo,
          hook_id: existingWebhook.id,
          config: {
            content_type: "json",
            url: httpSource.url,
            secret,
          },
        });

        await triggerClient.updateHttpSource(httpSource.id, {
          secret,
          data: existingWebhook,
          active: true,
        });

        return;
      }

      // Generate secret

      if (!owner || !repo) {
        throw new Error(
          'Invalid repo, should be in format "owner/repo". For example: "triggerdotdev/trigger.dev"'
        );
      }

      const { data: webhook } = await client.rest.repos.createWebhook({
        owner,
        repo,
        events: params.events,
        config: {
          url: httpSource.url,
          content_type: "json",
          secret,
        },
      });

      await triggerClient.updateHttpSource(httpSource.id, {
        secret,
        data: webhook,
        active: true,
      });
    },
    handler: async (client, source, auth) => {
      const deliveryId = source.request.headers["x-github-delivery"];
      const hookId = source.request.headers["x-github-hook-id"];
      const signature = source.request.headers["x-hub-signature-256"];

      if (source.secret && signature) {
        const githubWebhooks = new Webhooks({
          secret: source.secret,
        });

        if (!githubWebhooks.verify(source.request.body, signature)) {
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

      const name = source.request.headers["x-github-event"];

      const context = omit(source.request.headers, [
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

      const payload = parseBody(source.request.body);

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
