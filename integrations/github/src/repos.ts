import { IntegrationTaskKey } from "@trigger.dev/sdk";
import { Octokit } from "octokit";
import { GitHubReturnType, GitHubRunTask, onError } from "./index";

export class Repos {
  constructor(private runTask: GitHubRunTask) {}

  get(
    key: IntegrationTaskKey,
    params: { owner: string; repo: string }
  ): GitHubReturnType<Octokit["rest"]["repos"]["get"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.repos.get({
          owner: params.owner,
          repo: params.repo,
          headers: {
            "x-trigger-attempt": String(task.attempts),
          },
        });
        return result.data;
      },
      {
        name: "Get Repo",
        params,
        properties: [
          {
            label: "Repo",
            text: params.repo,
          },
        ],
      },
      onError
    );
  }

  updateWebhook(
    key: IntegrationTaskKey,
    params: {
      owner: string;
      repo: string;
      hookId: number;
      url: string;
      secret: string;
      addEvents?: string[];
    }
  ): GitHubReturnType<Octokit["rest"]["repos"]["updateWebhook"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.repos.updateWebhook({
          owner: params.owner,
          repo: params.repo,
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
        name: "Update Webhook",
        params,
        properties: [
          {
            label: "Owner",
            text: params.owner,
          },
          {
            label: "Repo",
            text: params.repo,
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
      owner: string;
      repo: string;
      url: string;
      secret: string;
      events: string[];
    }
  ): GitHubReturnType<Octokit["rest"]["repos"]["createWebhook"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.repos.createWebhook({
          owner: params.owner,
          repo: params.repo,
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
        name: "Create Webhook",
        params,
        properties: [
          {
            label: "Owner",
            text: params.owner,
          },
          {
            label: "Repo",
            text: params.repo,
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
      owner: string;
      repo: string;
    }
  ): GitHubReturnType<Octokit["rest"]["repos"]["listWebhooks"]> {
    return this.runTask(
      key,
      async (client, task) => {
        const result = await client.rest.repos.listWebhooks({
          owner: params.owner,
          repo: params.repo,
        });
        return result.data;
      },
      {
        name: "List Webhooks",
        params,
        properties: [
          {
            label: "Owner",
            text: params.owner,
          },
          {
            label: "Repo",
            text: params.repo,
          },
        ],
      },
      onError
    );
  }
}
