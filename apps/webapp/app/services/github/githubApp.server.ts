import type { Endpoints } from "@octokit/types";
import { verify } from "@octokit/webhooks-methods";
import { sign as signJWT } from "jsonwebtoken";
import { z } from "zod";
import { env } from "~/env.server";
import type { EmitterWebhookEventName } from "@octokit/webhooks";
import { taskQueue } from "../messageBroker.server";

export async function verifyAndReceiveWebhook(request: Request) {
  if (!env.GITHUB_APP_WEBHOOK_SECRET) {
    return new Response("", { status: 200 });
  }

  const payload = await request.text();
  const headers = Object.fromEntries(request.headers.entries());

  console.log(headers);

  const id = headers["x-github-delivery"];
  const hookName = headers["x-github-event"];
  const signature = headers["x-hub-signature"];

  const results = await verify(
    env.GITHUB_APP_WEBHOOK_SECRET,
    payload,
    signature
  );

  if (!results) {
    console.error(`[webhooks.github] Invalid signature`, {
      id,
      hookName,
      signature,
    });

    return new Response("", { status: 200 });
  }

  const parsedPayload = JSON.parse(payload);

  const name = `${hookName}.${parsedPayload.action}` as EmitterWebhookEventName;

  console.log(`[webhooks.github] Received event`, {
    id,
    name,
    payload: parsedPayload,
  });

  await handleGithubEvent({
    id,
    name,
    payload: parsedPayload,
  });

  return new Response("", { status: 200 });
}

async function handleGithubEvent<TName extends EmitterWebhookEventName>({
  id,
  name,
  payload,
}: {
  id: string;
  name: TName;
  payload: any;
}) {
  switch (name) {
    case "installation.deleted": {
      await taskQueue.publish("GITHUB_APP_INSTALLATION_DELETED", {
        id: payload.installation.id,
      });
    }
  }
}

type GetAppInstallationEndpoint =
  Endpoints["GET /app/installations/{installation_id}"];

export async function getAppInstallation({
  installation_id,
}: GetAppInstallationEndpoint["parameters"]): Promise<
  GetAppInstallationEndpoint["response"]["data"]
> {
  const jwt = createSignedGitHubAppJWT();

  const response = await fetch(
    `https://api.github.com/app/installations/${installation_id}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github.v3+json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to get installation ${installation_id}: ${response.statusText}`
    );
  }

  return await response.json();
}

export async function getOAuthAccessToken({
  code,
  state,
}: {
  code: string;
  state: string;
}) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      code,
      state,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get OAuth access token: ${response.statusText}`);
  }

  const { access_token, token_type } = await response.json();

  return { accessToken: access_token, tokenType: token_type };
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

function createSignedGitHubAppJWT() {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("Missing GitHub App ID or private key");
  }

  const privateKey = Buffer.from(env.GITHUB_APP_PRIVATE_KEY, "base64").toString(
    "utf8"
  );

  const unsignedJWT = {
    iat: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 10 * 60,
    iss: env.GITHUB_APP_ID,
  };

  const signedJWT = signJWT(unsignedJWT, privateKey, {
    algorithm: "RS256",
  });

  return signedJWT;
}
