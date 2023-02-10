import { Webhooks, EmitterWebhookEvent } from "@octokit/webhooks";
import { Octokit } from "@octokit/core";
import { createAppAuth } from "@octokit/auth-app";
import { OAuthApp } from "@octokit/oauth-app";
import { createUnauthenticatedAuth } from "@octokit/auth-unauthenticated";
import { env } from "~/env.server";
import { Options } from "@octokit/oauth-app/dist-types/types";
import type { Endpoints } from "@octokit/types";
import { z } from "zod";

export const octokit = env.GITHUB_APP_PRIVATE_KEY
  ? new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: env.GITHUB_APP_ID,
        privateKey: Buffer.from(env.GITHUB_APP_PRIVATE_KEY, "base64").toString(
          "utf8"
        ),
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      },
      log: {
        debug: console.log,
        info: console.log,
        warn: console.warn,
        error: console.error,
      },
    })
  : undefined;

export const oauthApp = createOauthApp();

export const webhooks = createWebhooks();

declare global {
  var __github_webhooks__:
    | Webhooks<EmitterWebhookEvent & { octokit: Octokit }>
    | undefined;
  var __github_oauth_app__: OAuthApp<Options<"github-app">> | undefined;
}

function createOauthApp() {
  if (typeof global.__github_oauth_app__ !== "undefined") {
    return global.__github_oauth_app__;
  }

  if (typeof env.GITHUB_APP_CLIENT_ID === "undefined") {
    return;
  }

  if (typeof env.GITHUB_APP_CLIENT_SECRET === "undefined") {
    return;
  }

  global.__github_oauth_app__ = new OAuthApp({
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    clientType: "github-app",
  });

  global.__github_oauth_app__.on("token", async (event) => {});

  return __github_oauth_app__;
}

function createWebhooks() {
  if (typeof global.__github_webhooks__ !== "undefined") {
    return global.__github_webhooks__;
  }

  if (
    typeof env.GITHUB_APP_WEBHOOK_SECRET === "undefined" ||
    typeof octokit === "undefined"
  ) {
    return;
  }

  global.__github_webhooks__ = __webhooks(
    octokit,
    env.GITHUB_APP_WEBHOOK_SECRET
  );

  global.__github_webhooks__.on("push", ({ octokit, payload }) => {});
  global.__github_webhooks__.onAny((event) => {});

  return global.__github_webhooks__;
}

function __webhooks(
  appOctokit: Octokit,
  secret: string
  // Explict return type for better debugability and performance,
  // see https://github.com/octokit/app.js/pull/201
): Webhooks<EmitterWebhookEvent & { octokit: Octokit }> {
  return new Webhooks({
    secret,
    transform: async (event) => {
      if (
        !("installation" in event.payload) ||
        typeof event.payload.installation !== "object"
      ) {
        const octokit = new (appOctokit.constructor as typeof Octokit)({
          authStrategy: createUnauthenticatedAuth,
          auth: {
            reason: `"installation" key missing in webhook event payload`,
          },
        });

        return {
          ...event,
          octokit,
        };
      }

      const installationId = event.payload.installation.id;
      const octokit = (await appOctokit.auth({
        type: "installation",
        installationId,
        factory(auth: any) {
          return new auth.octokit.constructor({
            ...auth.octokitOptions,
            authStrategy: createAppAuth,
            ...{
              auth: {
                ...auth,
                installationId,
              },
            },
          });
        },
      })) as Octokit;

      // set `x-github-delivery` header on all requests sent in response to the current
      // event. This allows GitHub Support to correlate the request with the event.
      // This is not documented and not considered public API, the header may change.
      // Once we document this as best practice on https://docs.github.com/en/rest/guides/best-practices-for-integrators
      // we will make it official
      /* istanbul ignore next */
      octokit.hook.before("request", (options) => {
        options.headers["x-github-delivery"] = event.id;
      });

      return {
        ...event,
        octokit,
      };
    },
  });
}

type GetAppInstallationEndpoint =
  Endpoints["GET /app/installations/{installation_id}"];

export async function getAppInstallation({
  installation_id,
}: GetAppInstallationEndpoint["parameters"]) {
  if (typeof octokit === "undefined") {
    return;
  }

  const response = await octokit.request(
    "GET /app/installations/{installation_id}",
    {
      installation_id,
    }
  );

  return response.data;
}

type CreateRepositoryFromTemplateEndpoint =
  Endpoints["POST /repos/{template_owner}/{template_repo}/generate"];

export async function createRepositoryFromTemplate(
  parameters: CreateRepositoryFromTemplateEndpoint["parameters"],
  { installationId }: { installationId?: number }
) {
  if (typeof octokit === "undefined") {
    return;
  }

  const kit = installationId ? await getOctokit(installationId) : octokit;

  const response = await kit.request(
    "POST /repos/{template_owner}/{template_repo}/generate",
    parameters
  );

  return response.data;
}

async function getOctokit(installationId: number): Promise<Octokit> {
  return octokit!.auth({
    type: "installation",
    installationId,
    factory(auth: any) {
      return new auth.octokit.constructor({
        ...auth.octokitOptions,
        authStrategy: createAppAuth,
        ...{
          auth: {
            ...auth,
            installationId,
          },
        },
      });
    },
  }) as Promise<Octokit>;
}

export const AccountSchema = z.object({
  login: z.string(),
  id: z.number(),
  node_id: z.string(),
  name: z.string().optional(),
  email: z.string().optional().nullable(),
  avatar_url: z.string(),
  gravatar_id: z.string(),
  url: z.string(),
  html_url: z.string(),
  followers_url: z.string(),
  following_url: z.string(),
  gists_url: z.string(),
  starred_url: z.string(),
  subscriptions_url: z.string(),
  organizations_url: z.string(),
  repos_url: z.string(),
  events_url: z.string(),
  received_events_url: z.string(),
  type: z.union([
    z.literal("Bot"),
    z.literal("User"),
    z.literal("Organization"),
  ]),
  site_admin: z.boolean(),
});
