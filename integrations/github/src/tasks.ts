import { Octokit } from "octokit";
import type { GetResponseDataTypeFromEndpointMethod } from "@octokit/types";
import type { AuthenticatedTask } from "@trigger.dev/sdk";

type OctokitClient = InstanceType<typeof Octokit>;

type GithubAuthenticatedTask<
  TParams extends Record<string, unknown>,
  TFunction extends (...args: any[]) => any
> = AuthenticatedTask<
  OctokitClient,
  TParams,
  GetResponseDataTypeFromEndpointMethod<TFunction>
>;

export const createIssue: GithubAuthenticatedTask<
  { title: string; repo: string },
  OctokitClient["rest"]["issues"]["create"]
> = {
  run: async (params, client) => {
    const [owner, repo] = params.repo.split("/");

    return client.rest.issues
      .create({
        owner,
        repo,
        title: params.title,
      })
      .then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Create Issue",
      params,
      properties: [
        {
          label: "Repo",
          text: params.repo,
        },
        {
          label: "Title",
          text: params.title,
        },
      ],
    };
  },
};

export const createIssueComment: GithubAuthenticatedTask<
  { body: string; repo: string; issueNumber: number },
  OctokitClient["rest"]["issues"]["createComment"]
> = {
  run: async (params, client) => {
    const [owner, repo] = params.repo.split("/");

    return client.rest.issues
      .createComment({
        owner,
        repo,
        body: params.body,
        issue_number: params.issueNumber,
      })
      .then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Create Issue Comment",
      params,
      properties: [
        {
          label: "Repo",
          text: params.repo,
        },
        {
          label: "Issue",
          text: `#${params.issueNumber}`,
        },
      ],
    };
  },
};

export const getRepo: GithubAuthenticatedTask<
  { repo: string },
  OctokitClient["rest"]["repos"]["get"]
> = {
  run: async (params, client) => {
    const [owner, repo] = params.repo.split("/");

    const response = await client.rest.repos.get({
      owner,
      repo,
    });

    return response.data;
  },
  init: (params) => {
    return {
      name: "Get Repo",
      params,
      properties: [
        {
          label: "Repo",
          text: params.repo,
        },
      ],
    };
  },
};

type ReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

export const addIssueCommentReaction: GithubAuthenticatedTask<
  {
    repo: string;
    commentId: number;
    content: ReactionContent;
  },
  OctokitClient["rest"]["reactions"]["createForIssueComment"]
> = {
  run: async (params, client) => {
    const [owner, repo] = params.repo.split("/");

    return client.rest.reactions
      .createForIssueComment({
        owner,
        repo,
        comment_id: params.commentId,
        content: params.content,
      })
      .then((res) => res.data);
  },
  init: (params) => {
    let emoji = "";

    switch (params.content) {
      case "+1":
        emoji = "👍";
        break;
      case "-1":
        emoji = "👎";
        break;
      case "laugh":
        emoji = "😄";
        break;
      case "confused":
        emoji = "😕";
        break;
      case "heart":
        emoji = "❤️";
        break;
      case "hooray":
        emoji = "🎉";
        break;
      case "rocket":
        emoji = "🚀";
        break;
      case "eyes":
        emoji = "👀";
        break;
    }

    return {
      name: "Add Issue Reaction",
      params,
      properties: [
        {
          label: "Repo",
          text: params.repo,
        },
        {
          label: "Comment",
          text: `#${params.commentId}`,
        },
        { label: "reaction", text: emoji },
      ],
    };
  },
};

export const createIssueCommentWithReaction: GithubAuthenticatedTask<
  {
    body: string;
    repo: string;
    issueNumber: number;
    reaction: ReactionContent;
  },
  OctokitClient["rest"]["issues"]["createComment"]
> = {
  run: async (params, client, task, io) => {
    const comment = await io.runTask(
      `Comment on Issue #${params.issueNumber}`,
      createIssueComment.init(params),
      async (t) => {
        return createIssueComment.run(params, client, t, io);
      }
    );

    await io.runTask(
      `React with ${params.reaction}`,
      addIssueCommentReaction.init({
        repo: params.repo,
        commentId: comment.id,
        content: params.reaction,
      }),
      async (t) => {
        return addIssueCommentReaction.run(
          {
            repo: params.repo,
            commentId: comment.id,
            content: params.reaction,
          },
          client,
          t,
          io
        );
      }
    );

    return comment;
  },
  init: (params) => {
    return {
      name: "Create Issue Comment",
      params,
      properties: [
        {
          label: "Repo",
          text: params.repo,
        },
        {
          label: "Issue",
          text: `#${params.issueNumber}`,
        },
      ],
    };
  },
};

export const updateWebhook: GithubAuthenticatedTask<
  {
    repo: string;
    hookId: number;
    url: string;
    secret: string;
    addEvents?: string[];
  },
  OctokitClient["rest"]["repos"]["updateWebhook"]
> = {
  run: async (params, client) => {
    const [owner, repo] = params.repo.split("/");

    return client.rest.repos
      .updateWebhook({
        owner,
        repo,
        hook_id: params.hookId,
        config: {
          content_type: "json",
          url: params.url,
          secret: params.secret,
        },
        add_events: params.addEvents,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Update Webhook",
      params,
      properties: [
        {
          label: "Repo",
          text: params.repo,
        },
        {
          label: "Hook ID",
          text: String(params.hookId),
        },
      ],
    };
  },
};

export const updateOrgWebhook: GithubAuthenticatedTask<
  {
    org: string;
    hookId: number;
    url: string;
    secret: string;
    addEvents?: string[];
  },
  OctokitClient["rest"]["orgs"]["updateWebhook"]
> = {
  run: async (params, client) => {
    return client.rest.orgs
      .updateWebhook({
        org: params.org,
        hook_id: params.hookId,
        config: {
          content_type: "json",
          url: params.url,
          secret: params.secret,
        },
        add_events: params.addEvents,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
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
    };
  },
};

export const createWebhook: GithubAuthenticatedTask<
  {
    repo: string;
    url: string;
    secret: string;
    events: string[];
  },
  OctokitClient["rest"]["repos"]["createWebhook"]
> = {
  run: async (params, client) => {
    const [owner, repo] = params.repo.split("/");

    return client.rest.repos
      .createWebhook({
        owner,
        repo,
        config: {
          content_type: "json",
          url: params.url,
          secret: params.secret,
        },
        events: params.events,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "Create Webhook",
      params,
      properties: [
        {
          label: "Repo",
          text: params.repo,
        },
        {
          label: "Events",
          text: params.events.join(", "),
        },
      ],
    };
  },
};

export const createOrgWebhook: GithubAuthenticatedTask<
  {
    org: string;
    url: string;
    secret: string;
    events: string[];
  },
  OctokitClient["rest"]["orgs"]["createWebhook"]
> = {
  run: async (params, client, task) => {
    return client.rest.orgs
      .createWebhook({
        org: params.org,
        name: "web",
        config: {
          content_type: "json",
          url: params.url,
          secret: params.secret,
        },
        events: params.events,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
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
    };
  },
};

export const listWebhooks: GithubAuthenticatedTask<
  {
    repo: string;
  },
  OctokitClient["rest"]["repos"]["listWebhooks"]
> = {
  run: async (params, client) => {
    const [owner, repo] = params.repo.split("/");

    return client.rest.repos
      .listWebhooks({
        owner,
        repo,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "List Webhooks",
      params,
      properties: [
        {
          label: "Repo",
          text: params.repo,
        },
      ],
    };
  },
};

export const listOrgWebhooks: GithubAuthenticatedTask<
  {
    org: string;
  },
  OctokitClient["rest"]["orgs"]["listWebhooks"]
> = {
  run: async (params, client) => {
    return client.rest.orgs
      .listWebhooks({
        org: params.org,
      })
      .then((response) => response.data);
  },
  init: (params) => {
    return {
      name: "List Org Webhooks",
      params,
      properties: [
        {
          label: "Org",
          text: params.org,
        },
      ],
    };
  },
};

export const tasks = {
  createIssue,
  createIssueComment,
  getRepo,
  createIssueCommentWithReaction,
  addIssueCommentReaction,
  updateWebhook,
  createWebhook,
  listWebhooks,
  updateOrgWebhook,
  createOrgWebhook,
  listOrgWebhooks,
};
