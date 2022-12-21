import {
  HandleWebhookOptions,
  WebhookConfig,
  WebhookIntegration,
} from "../types";

import { WebhookSchema, IssueEventSchema } from "./schemas";

export class GitHubWebhookIntegration implements WebhookIntegration {
  registerWebhook(config: WebhookConfig, params: unknown) {
    const parsedParams = parseWebhookData(params);

    return registerWebhook(config, {
      repo: parsedParams.params.repo,
      events: parsedParams.events,
    });
  }

  handleWebhookRequest(options: HandleWebhookOptions) {
    return options.request.body;
  }
}

export const webhooks = new GitHubWebhookIntegration();
export const schemas = {
  IssueEventSchema,
  WebhookSchema,
};

async function registerWebhook(
  config: WebhookConfig,
  options: { repo: string; events: string[] }
) {
  // Create the webhook in github
  const response = await fetch(
    `https://api.github.com/repos/${options.repo}/hooks`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        name: "web",
        active: true,
        events: options.events,
        config: {
          url: config.callbackUrl,
          content_type: "json",
          secret: config.secret,
          insecure_ssl: "0",
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to register webhook: ${response.statusText}`);
  }

  const webhook = await response.json();

  return webhook;
}

function parseWebhookData(data: unknown) {
  return WebhookSchema.parse(data);
}
