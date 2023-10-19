import { IntegrationTaskKey } from "@trigger.dev/sdk";
import { Octokit } from "octokit";
import { GitHubReturnType, GitHubRunTask, onError } from "./index";

export class Orgs {
  constructor(private runTask: GitHubRunTask) {}

  updateWebhook(
    key: IntegrationTaskKey,
    params: {
      org: string;
      hookId: number;
      url: string;
      secret: string;
      addEvents?: string[];
    }
  ): GitHubReturnType<Octokit["rest"]["orgs"]["updateWebhook"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.orgs.updateWebhook({
          org: params.org,
          hook_id: params.hookId,
          config: {
            content_type: "json",
            url: params.url,
            secret: params.secret,
          },
          add_events: params.addEvents,
        });
        return result.data;
      },
      {
        name: "Update Org Webhook",
        params,
        properties: [
          {
            label: "Org",
            text: params.org,
          },
          {
            label: "Hook ID",
            text: String(params.hookId),
          },
        ],
      },
      onError
    );
  }

  createWebhook(
    key: IntegrationTaskKey,
    params: {
      org: string;
      url: string;
      secret: string;
      events: string[];
    }
  ): GitHubReturnType<Octokit["rest"]["orgs"]["createWebhook"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.orgs.createWebhook({
          org: params.org,
          name: "web",
          config: {
            content_type: "json",
            url: params.url,
            secret: params.secret,
          },
          events: params.events,
        });
        return result.data;
      },
      {
        name: "Create Org Webhook",
        params,
        properties: [
          {
            label: "Org",
            text: params.org,
          },
          {
            label: "Events",
            text: params.events.join(", "),
          },
        ],
      },
      onError
    );
  }

  listWebhooks(
    key: IntegrationTaskKey,
    params: {
      org: string;
    }
  ): GitHubReturnType<Octokit["rest"]["orgs"]["listWebhooks"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.orgs.listWebhooks({
          org: params.org,
        });
        return result.data;
      },
      {
        name: "List Org Webhooks",
        params,
        properties: [
          {
            label: "Org",
            text: params.org,
          },
        ],
      },
      onError
    );
  }
}
